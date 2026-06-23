// netlify/functions/pulse-ingest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PULSE · INGEST
// A Nayra chama este endpoint (de forma assíncrona) toda vez que um cliente
// pergunta sobre um produto. Ele:
//   1. Recebe a frase crua + o status que o STOCK devolveu.
//   2. Normaliza a frase em um "conceito de produto" usando Claude Haiku
//      (agrupa "panela de porcelana" e "jogo de panela de cerâmica" no mesmo).
//   3. Atualiza os agregados nos Netlify Blobs (contagem, variantes, status...).
//
// Importante: este endpoint NUNCA deve travar a resposta da Nayra ao cliente.
// A Nayra dispara e segue (fire-and-forget); o trabalho acontece aqui no fundo.
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

const MODEL = 'claude-haiku-4-5-20251001';
const VALID_STATUS = ['IN_STOCK', 'OUT_OF_STOCK', 'NOT_IN_CATALOG'];
const VALID_HEAT = ['cold', 'warm', 'hot'];

// ── utilidades ───────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function slugify(s) {
  return (s || 'produto')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acentos
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'produto';
}

function rand4() {
  return Math.random().toString(36).slice(2, 6);
}

// chave de semana ISO, ex.: "2026-W25" — usada no mini-gráfico do painel
function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── normalização (o pulo do gato) ───────────────────────────────────────────
// Pergunta ao Claude se a frase é um conceito já existente ou um novo.
// Devolve { match, id, name, category, keywords }.
async function normalize(rawQuery, hintName, existingConcepts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Envia uma versão enxuta dos conceitos existentes (id + nome + palavras-chave)
  // para o Claude decidir o agrupamento. Limita a 80 para não estourar tokens.
  const compact = existingConcepts.slice(0, 80).map((c) => ({
    id: c.id, name: c.name, keywords: c.keywords || [],
  }));

  // Plano B caso a IA falhe: nunca perdemos o dado.
  const fallback = () => {
    const hay = (rawQuery + ' ' + (hintName || '')).toLowerCase();
    const hit = existingConcepts.find((c) =>
      hay.includes((c.name || '').toLowerCase()) ||
      (c.keywords || []).some((k) => hay.includes(k.toLowerCase()))
    );
    if (hit) return { match: true, id: hit.id, name: hit.name, category: hit.category || 'Geral', keywords: hit.keywords || [] };
    const name = hintName || rawQuery.trim().slice(0, 60);
    return { match: false, id: null, name, category: 'Geral', keywords: [] };
  };

  if (!apiKey) return fallback();

  const sys = 'Você é um classificador de produtos de um e-commerce brasileiro. ' +
    'Receberá a frase de um cliente e a lista de conceitos de produto já existentes. ' +
    'Decida se a frase se refere a um conceito EXISTENTE (mesmo produto, escrito de outro jeito) ou a um produto NOVO. ' +
    'Gere um nome canônico curto e comercial em português. ' +
    'O cliente pode escrever em português, inglês ou espanhol — o nome canônico deve SEMPRE sair em português, ' +
    'para o mesmo produto não se dividir por idioma (ex.: "porcelain cookware" e "olla de porcelana" → "jogo de panelas de porcelana"). ' +
    'Responda APENAS com JSON válido, sem markdown, sem cercas de código, sem texto extra. ' +
    'Schema: {"match": boolean, "id": string|null, "name": string, "category": string, "keywords": string[]}';

  const userMsg = JSON.stringify({
    frase_do_cliente: rawQuery,
    sugestao_da_nayra: hintName || null,
    conceitos_existentes: compact,
  });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!resp.ok) return fallback();
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed.name !== 'string' || !parsed.name) return fallback();
    // se disse que casou mas o id não existe, trata como novo
    if (parsed.match && !existingConcepts.some((c) => c.id === parsed.id)) parsed.match = false;
    return {
      match: !!parsed.match,
      id: parsed.match ? parsed.id : null,
      name: parsed.name.slice(0, 60),
      category: (parsed.category || 'Geral').slice(0, 30),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [],
    };
  } catch {
    return fallback();
  }
}

// ── handler ──────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const {
    raw_query,
    canonical_name = null, // nome que a Nayra propôs/confirmou (opcional)
    confirmed = false,     // o cliente validou o nome? (opcional)
    stock_status,          // veio do STOCK: IN_STOCK | OUT_OF_STOCK | NOT_IN_CATALOG
    intent_heat = 'warm',  // cold | warm | hot
    session_id = null,     // p/ contar PESSOAS, não perguntas
  } = body;

  if (!raw_query || typeof raw_query !== 'string') return json({ error: 'raw_query obrigatório' }, 400);
  if (!VALID_STATUS.includes(stock_status)) return json({ error: 'stock_status inválido' }, 400);
  const heat = VALID_HEAT.includes(intent_heat) ? intent_heat : 'warm';

  // consistency: 'strong' garante leitura-após-escrita imediata (lemos e gravamos o mesmo blob)
  const store = getStore({ name: 'pulse', consistency: 'strong' });

  const index = (await store.get('index', { type: 'json' })) || { concepts: [], updated_at: null };

  const norm = await normalize(raw_query, canonical_name, index.concepts);

  // resolve o id do conceito
  let id = norm.match ? norm.id : `${slugify(norm.name)}-${rand4()}`;

  const now = new Date().toISOString();
  const week = isoWeek();

  // carrega (ou inicia) o conceito
  let concept = (await store.get(`concept:${id}`, { type: 'json' })) || {
    id,
    name: norm.name,
    category: norm.category,
    current_status: stock_status,
    first_seen: now,
    last_seen: now,
    unique_people: 0,
    total_mentions: 0,
    heat: { cold: 0, warm: 0, hot: 0 },
    sessions: [],     // ids de sessão já contabilizados
    variants: [],     // [{ text, count }] — as formas como pediram
    weekly: {},       // { "2026-W25": n }
  };

  // ── atualiza os agregados ──
  concept.total_mentions += 1;
  concept.heat[heat] += 1;
  concept.current_status = stock_status; // o status mais recente vale
  concept.last_seen = now;
  concept.category = concept.category || norm.category;
  if (confirmed && canonical_name) concept.name = canonical_name; // confirmação do cliente refina o nome

  // pessoas únicas
  if (session_id && !concept.sessions.includes(session_id)) {
    concept.sessions.push(session_id);
  }
  concept.unique_people = session_id ? concept.sessions.length : concept.unique_people + 1;

  // variante (forma como pediram) — guarda só as 7 mais frequentes
  const vText = raw_query.trim().toLowerCase().slice(0, 120);
  const v = concept.variants.find((x) => x.text === vText);
  if (v) {
    v.count += 1;
  } else {
    concept.variants.push({ text: vText, count: 1 });
    // mantém só as 7 mais frequentes; as outras caem fora mas a contagem permanece em total_mentions
    concept.variants.sort((a, b) => b.count - a.count).splice(7);
  }

  // semana
  concept.weekly[week] = (concept.weekly[week] || 0) + 1;

  await store.setJSON(`concept:${id}`, concept);

  // ── atualiza o resumo no índice (o painel lê só isto p/ os rankings) ──
  const heatScore = concept.heat.cold * 1 + concept.heat.warm * 2 + concept.heat.hot * 3;
  const summary = {
    id,
    name: concept.name,
    category: concept.category,
    current_status: concept.current_status,
    unique_people: concept.unique_people,
    total_mentions: concept.total_mentions,
    heat: concept.heat,
    heat_score: heatScore,
    first_seen: concept.first_seen,
    last_seen: concept.last_seen,
    keywords: Array.from(new Set([...(norm.keywords || [])])).slice(0, 8),
  };
  const i = index.concepts.findIndex((c) => c.id === id);
  if (i >= 0) index.concepts[i] = summary; else index.concepts.push(summary);
  index.updated_at = now;

  await store.setJSON('index', index);

  return json({ ok: true, id, name: concept.name, status: concept.current_status });
};
