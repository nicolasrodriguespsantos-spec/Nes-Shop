// netlify/functions/create-preference.mjs
// ─────────────────────────────────────────────────────────────────────────────
// MERCADO PAGO · CRIA O LINK DE PAGAMENTO (Checkout Pro)
//
// Recebe o carrinho do site, monta a "preferência" (o pacote com o que está
// sendo vendido) e pede pro Mercado Pago um link de checkout. O cliente é
// redirecionado pra esse link — o pagamento em si acontece INTEIRO dentro do
// Mercado Pago. A N.E.S nunca vê número de cartão, nunca lida com PCI-DSS.
//
// MODO TESTE: enquanto MP_ACCESS_TOKEN for uma credencial de TESTE (começa
// com "TEST-"), o Mercado Pago não move dinheiro real — só aceita
// "compradores de teste" e cartões fictícios. Veja as notas no final.
//
// IMPORTANTE — o que este arquivo NÃO faz (de propósito, por enquanto):
// ele não confirma pagamento. Ele só ABRE o caminho até o Mercado Pago.
// A confirmação de verdade (saber que o dinheiro caiu) vem do WEBHOOK,
// que é a próxima peça a construir. Redirecionar pro checkout é seguro;
// confiar que "voltou = pagou" sem o webhook NÃO é — fica registrado aqui
// pra não esquecermos disso na hora de tratar o retorno no site.
// ─────────────────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!ACCESS_TOKEN) return json({ error: 'MP_ACCESS_TOKEN não configurado no Netlify' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const cart = Array.isArray(body.items) ? body.items : [];
  if (!cart.length) return json({ error: 'carrinho vazio' }, 400);

  // Netlify preenche process.env.URL com a URL pública do site.
  const baseUrl = process.env.URL || '';

  // Formato que o Mercado Pago espera para cada item.
  const items = cart.map((it) => ({
    title: String(it.name || 'Produto').slice(0, 250),
    quantity: Math.max(1, parseInt(it.qty, 10) || 1),
    unit_price: Number(it.price) || 0,
    currency_id: 'BRL',
  }));

  // Referência própria — é o gancho que o webhook (próxima etapa) vai usar
  // pra saber a QUAL pedido um pagamento aprovado pertence.
  const externalRef = 'nes-' + Date.now();

  const preference = {
    items,
    back_urls: {
      success: baseUrl + '/?pagamento=aprovado',
      failure: baseUrl + '/?pagamento=recusado',
      pending: baseUrl + '/?pagamento=pendente',
    },
    auto_return: 'approved',
    statement_descriptor: 'NES SHOP',
    external_reference: externalRef,
    // Para onde o Mercado Pago vai notificar (webhook) quando o pagamento mudar
    // de status. É esta URL que recebe a confirmação à prova de fraude.
    notification_url: baseUrl + '/.netlify/functions/mp-webhook',
  };

  try {
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
      },
      body: JSON.stringify(preference),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Mercado Pago recusou a preferência:', JSON.stringify(data));
      return json({ error: 'mercado_pago_error', detail: data }, 502);
    }

    // Com credencial de TESTE, o link certo é o sandbox_init_point.
    // Com credencial de PRODUÇÃO (mais pra frente), vira init_point.
    const isTest = ACCESS_TOKEN.startsWith('TEST-');
    const checkoutUrl = isTest ? (data.sandbox_init_point || data.init_point) : data.init_point;

    return json({ checkoutUrl, preferenceId: data.id, externalRef });
  } catch (e) {
    console.error('Erro ao criar preferência:', e);
    return json({ error: 'falha ao conectar com o Mercado Pago' }, 502);
  }
};
