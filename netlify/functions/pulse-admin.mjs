// netlify/functions/pulse-admin.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PULSE · ADMIN (escrita/manutenção, privado)
// POST protegido pelo mesmo segredo do PULSE (PULSE_SECRET). Duas ações:
//   • { action:'delete', id:'<conceito>' } → apaga concept:{id} e tira do índice.
//   • { action:'reset' }                   → apaga TODOS os conceitos e esvazia o índice.
// Não mexe em métricas (metrics:*), só no radar do PULSE (index + concept:*).
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  const url = new URL(req.url);
  const secret = process.env.PULSE_SECRET;
  if (!secret) return json({ error: 'PULSE_SECRET não configurado' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const token = (body && body.token) ||
                (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
                url.searchParams.get('token') || '';
  if (token !== secret) return json({ error: 'não autorizado' }, 401);

  const store = getStore({ name: 'pulse', consistency: 'strong' });
  const index = (await store.get('index', { type: 'json' })) || { concepts: [], updated_at: null };

  if (body.action === 'delete') {
    const id = String(body.id || '');
    if (!id) return json({ error: 'id obrigatório' }, 400);
    await store.delete(`concept:${id}`);
    index.concepts = index.concepts.filter((c) => c.id !== id);
    index.updated_at = new Date().toISOString();
    await store.setJSON('index', index);
    return json({ ok: true, deleted: id });
  }

  if (body.action === 'reset') {
    for (const c of index.concepts) {
      if (c && c.id) await store.delete(`concept:${c.id}`);
    }
    await store.setJSON('index', { concepts: [], updated_at: new Date().toISOString() });
    return json({ ok: true, reset: true });
  }

  return json({ error: 'ação desconhecida' }, 400);
};
