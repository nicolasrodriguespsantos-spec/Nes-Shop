// netlify/functions/metrics-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// MÉTRICAS · DATA
// GET  → devolve os baldes diários recentes + o heartbeat dos agentes (leitura).
// POST → ações de manutenção protegidas: excluir um dia ou zerar tudo.
// Protegido pelo mesmo segredo do PULSE (PULSE_SECRET).
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

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

  // ── ESCRITA (manutenção): excluir um dia ou zerar tudo ───────────────────────
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

    const token = (body && body.token) ||
                  (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
                  url.searchParams.get('token') || '';
    if (token !== secret) return json({ error: 'não autorizado' }, 401);

    const idx = (await store.get('metrics:index', { type: 'json' })) || { days: [] };

    if (body.action === 'delete') {
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'data inválida' }, 400);
      await store.delete('metrics:' + date);
      idx.days = idx.days.filter(d => d !== date);
      await store.setJSON('metrics:index', idx);
      return json({ ok: true, deleted: date });
    }

    if (body.action === 'reset') {
      for (const d of idx.days) await store.delete('metrics:' + d);
      await store.setJSON('metrics:index', { days: [] });
      return json({ ok: true, reset: true });
    }

    return json({ error: 'ação desconhecida' }, 400);
  }

  // ── LEITURA ──────────────────────────────────────────────────────────────────
  const headerToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || url.searchParams.get('token') || '';
  if (token !== secret) return json({ error: 'não autorizado' }, 401);

  const idx = (await store.get('metrics:index', { type: 'json' })) || { days: [] };
  const days = idx.days.slice(-14); // últimos 14 dias
  const buckets = [];
  for (const d of days) {
    const b = await store.get('metrics:' + d, { type: 'json' });
    if (b) buckets.push(b);
  }
  const heartbeat = (await store.get('metrics:heartbeat', { type: 'json' })) || {};

  return json({ buckets, heartbeat });
};
