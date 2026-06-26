// netlify/functions/metrics-ingest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// MÉTRICAS · INGEST
// Recebe o "batimento" dos agentes (enviado pela Nayra) e agrega em baldes diários.
// Guarda também o último horário visto de cada agente (heartbeat) p/ a tela de saúde.
// Mesmo store do PULSE ('pulse'), com chaves separadas: metrics:*
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

// data no fuso de São Paulo, formato YYYY-MM-DD
function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const counters = (body && typeof body.counters === 'object' && body.counters) || {};
  const agents = Array.isArray(body.agents) ? body.agents : [];

  const store = getStore({ name: 'pulse', consistency: 'strong' });
  const day = hojeSP();
  const now = new Date().toISOString();

  // balde diário — soma os contadores recebidos
  const key = 'metrics:' + day;
  const bucket = (await store.get(key, { type: 'json' })) || { date: day };
  for (const [k, v] of Object.entries(counters)) {
    if (typeof v === 'number' && isFinite(v)) bucket[k] = (bucket[k] || 0) + v;
  }
  await store.setJSON(key, bucket);

  // índice de dias (mantém os últimos 60)
  const idx = (await store.get('metrics:index', { type: 'json' })) || { days: [] };
  if (!idx.days.includes(day)) { idx.days.push(day); idx.days = idx.days.sort().slice(-60); }
  await store.setJSON('metrics:index', idx);

  // heartbeat — último horário visto de cada agente
  const hb = (await store.get('metrics:heartbeat', { type: 'json' })) || {};
  for (const a of agents) if (typeof a === 'string') hb[a] = now;
  await store.setJSON('metrics:heartbeat', hb);

  return json({ ok: true });
};
