// netlify/functions/metrics-data.mjs
// ─────────────────────────────────────────────────────────────────────────────
// MÉTRICAS · DATA (somente leitura, privado)
// Devolve os baldes diários recentes + o heartbeat dos agentes, pro painel command.html.
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
  const headerToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || url.searchParams.get('token') || '';
  const secret = process.env.PULSE_SECRET;

  if (!secret) return json({ error: 'PULSE_SECRET não configurado' }, 500);
  if (token !== secret) return json({ error: 'não autorizado' }, 401);

  const store = getStore({ name: 'pulse', consistency: 'strong' });

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

