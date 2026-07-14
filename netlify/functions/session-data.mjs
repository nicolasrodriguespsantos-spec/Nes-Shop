// netlify/functions/session-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SESSÕES · RESUMO (sem texto de conversa)
//
// Responde à pergunta que mais importa: "quem quis comprar e sumiu?"
//
// PRIVACIDADE (decisão de projeto): NÃO guardamos o que o cliente escreveu nem
// o que a Nayra respondeu. Só o ESQUELETO da sessão — produto de interesse,
// se a intenção esquentou, quantas trocas, quando parou, se converteu.
// Escala melhor e é muito mais defensável perante a LGPD.
//
// GET  (?token=) → devolve as sessões recentes + os "abandonos quentes"
// POST           → { action:'checkout', session_id } marca a sessão como convertida
//                  { action:'delete', session_id }   apaga uma sessão
//                  { action:'reset' }                 limpa tudo (dados de teste)
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

// quanto tempo parada até considerarmos que o cliente foi embora
const MINUTOS_PARA_ABANDONO = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.PULSE_SECRET;
  if (!secret) return json({ error: 'PULSE_SECRET não configurado' }, 500);

  const store = getStore({ name: 'pulse', consistency: 'strong' });

  // ── ESCRITA ────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

    // O checkout vem do SITE (cliente), não do painel — por isso não exige o token
    // do admin. Ele só marca uma sessão como convertida; não lê nem apaga nada.
    if (body.action === 'checkout') {
      // O site NÃO sabe o session_id — ele é o IP, que só o servidor enxerga.
      // Derivamos aqui exatamente como a Nayra faz, pra bater com a sessão certa.
      const id = String(body.session_id || '') ||
                 req.headers.get('x-nf-client-connection-ip') ||
                 (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
                 'desconhecido';
      if (!id) return json({ error: 'sessão não identificada' }, 400);
      const s = await store.get('session:' + id, { type: 'json' });
      if (s) {
        s.converteu = true;
        s.valor = Number(body.valor) || s.valor || 0;
        s.last_seen = new Date().toISOString();
        await store.setJSON('session:' + id, s);
      }
      return json({ ok: true });
    }

    // As demais ações são de manutenção e exigem o segredo.
    const token = (body && body.token) ||
                  (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || '';
    if (token !== secret) return json({ error: 'não autorizado' }, 401);

    const idx = (await store.get('session:index', { type: 'json' })) || { ids: [] };

    if (body.action === 'delete') {
      const id = String(body.session_id || '');
      if (!id) return json({ error: 'session_id obrigatório' }, 400);
      await store.delete('session:' + id);
      idx.ids = idx.ids.filter((x) => x !== id);
      await store.setJSON('session:index', idx);
      return json({ ok: true, deleted: id });
    }

    if (body.action === 'reset') {
      for (const id of idx.ids) await store.delete('session:' + id);
      await store.setJSON('session:index', { ids: [] });
      return json({ ok: true, reset: true });
    }

    return json({ error: 'ação desconhecida' }, 400);
  }

  // ── LEITURA (painel) ───────────────────────────────────────────────────────
  const headerToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || url.searchParams.get('token') || '';
  if (token !== secret) return json({ error: 'não autorizado' }, 401);

  const idx = (await store.get('session:index', { type: 'json' })) || { ids: [] };
  const sessions = [];
  for (const id of idx.ids.slice(-120)) {
    const s = await store.get('session:' + id, { type: 'json' });
    if (s) sessions.push(s);
  }

  const agora = Date.now();
  const parada = (s) => (agora - new Date(s.last_seen).getTime()) / 60000;

  // ABANDONO QUENTE: quis comprar, não comprou, e já foi embora.
  const abandonos = sessions
    .filter((s) => s.intencao_quente && !s.converteu && parada(s) >= MINUTOS_PARA_ABANDONO)
    .map((s) => ({ ...s, minutos_parado: Math.round(parada(s)) }))
    .sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

  const convertidas = sessions.filter((s) => s.converteu);
  const quentes = sessions.filter((s) => s.intencao_quente);

  return json({
    sessions,
    abandonos,
    resumo: {
      total: sessions.length,
      com_intencao: quentes.length,
      convertidas: convertidas.length,
      abandonos_quentes: abandonos.length,
      // dos que QUISERAM comprar, quantos de fato compraram
      taxa_fechamento: quentes.length ? Math.round((convertidas.length / quentes.length) * 100) : null,
    },
  });
};
