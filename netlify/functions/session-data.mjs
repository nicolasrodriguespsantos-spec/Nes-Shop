// netlify/functions/session-ingest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SESSÕES · INGEST (grava o resumo — sem texto de conversa)
//
// Recebe o esqueleto da sessão da Nayra e agrega em session:{id}.
// É ESM (.mjs) de propósito: só um arquivo ESM pode usar @netlify/blobs.
// A nayra.js (CommonJS) chama esta função via fetch — mesmo padrão do
// pulse-ingest e do metrics-ingest, que já funcionam de forma confiável.
//
// NUNCA guarda o que o cliente escreveu. Só: produto de interesse, se a
// intenção esquentou, nº de trocas, quando parou, se converteu.
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const sessionId = String(body.session_id || '');
  if (!sessionId) return json({ error: 'session_id obrigatório' }, 400);

  const store = getStore({ name: 'pulse', consistency: 'strong' });
  const key = 'session:' + sessionId;
  const agora = new Date().toISOString();

  const s = (await store.get(key, { type: 'json' })) || {
    id: sessionId, inicio: agora, mensagens: 0,
    intencao_quente: false, converteu: false,
    produtos: [], ultimo_produto: null, flags_miss: 0,
  };

  s.mensagens += 1;
  s.last_seen = agora;
  if (body.intencao_quente) s.intencao_quente = true;
  if (body.flag_miss) s.flags_miss += 1;
  if (body.produto) {
    s.ultimo_produto = body.produto;
    if (!s.produtos.includes(body.produto)) s.produtos.push(body.produto);
    s.produtos = s.produtos.slice(-6);
  }

  await store.setJSON(key, s);

  const idx = (await store.get('session:index', { type: 'json' })) || { ids: [] };
  if (!idx.ids.includes(sessionId)) {
    idx.ids.push(sessionId);
    idx.ids = idx.ids.slice(-300);
    await store.setJSON('session:index', idx);
  }

  return json({ ok: true });
};
