// netlify/functions/pulse-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PULSE · DATA (somente leitura, privado)
// O painel (pulse.html) chama este endpoint para desenhar os rankings.
//   • Sem ?id  → devolve o índice inteiro (todos os conceitos p/ os rankings).
//   • Com ?id  → devolve o detalhe completo de um conceito (variantes, semanas...).
// Protegido por um segredo simples (env PULSE_SECRET). É inteligência de negócio:
// nunca deixe aberto. Para algo mais robusto depois, troque por Netlify Identity.
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);

  // autenticação: aceita header "Authorization: Bearer <segredo>" ou ?token=<segredo>
  const headerToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || url.searchParams.get('token') || '';
  const secret = process.env.PULSE_SECRET;

  if (!secret) return json({ error: 'PULSE_SECRET não configurado no servidor' }, 500);
  if (token !== secret) return json({ error: 'não autorizado' }, 401);

  const store = getStore({ name: 'pulse', consistency: 'strong' });

  // detalhe de um conceito
  const id = url.searchParams.get('id');
  if (id) {
    const concept = await store.get(`concept:${id}`, { type: 'json' });
    if (!concept) return json({ error: 'conceito não encontrado' }, 404);
    // não devolve a lista crua de sessões (privacidade + peso)
    const { sessions, ...safe } = concept;
    return json(safe);
  }

  // índice completo p/ os rankings
  const index = (await store.get('index', { type: 'json' })) || { concepts: [], updated_at: null };
  return json(index);
};

