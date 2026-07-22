// netlify/functions/mp-webhook.mjs
// ─────────────────────────────────────────────────────────────────────────────
// MERCADO PAGO · WEBHOOK (a confirmação de pagamento à prova de fraude)
//
// Esta é a VERDADE sobre o dinheiro. Diferente do retorno pela URL (que é só
// visual e forjável), aqui é o próprio Mercado Pago que chama nosso servidor,
// por trás, quando um pagamento muda de status.
//
// FLUXO (importante entender):
//  1. O Mercado Pago chama esta função e manda só um ID de pagamento —
//     NÃO manda "aprovado". Ele diz apenas "algo aconteceu com o pagamento X".
//  2. Nós pegamos esse ID e PERGUNTAMOS de volta ao Mercado Pago:
//     "o pagamento X está aprovado mesmo?" (GET /v1/payments/{id})
//  3. Só a resposta dessa pergunta, autenticada com o NOSSO token, é confiável.
//     É isso que impede alguém de forjar um "tá pago" falso.
//  4. Se aprovado de verdade → registramos e disparamos o e-mail de confirmação.
//  5. Respondemos 200 rápido — senão o Mercado Pago fica reenviando.
//
// ⚠️ TESTE: pagamentos feitos com credencial de TESTE (cartão APRO etc.) NÃO
// disparam webhook automaticamente. Para testar a mecânica, use o SIMULADOR
// no painel do Mercado Pago (Suas integrações → sua app → Webhooks → Simular).
// A validação real só ocorre em produção, com pagamento real (pós-CNPJ).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

function ok() {
  // Responder 200 é o que diz ao Mercado Pago "recebi, pode parar de reenviar".
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function unauthorized() {
  // 403: a notificação não passou na verificação de assinatura — pode ser
  // um impostor tentando forjar um "pagamento aprovado". Rejeitamos.
  return new Response(JSON.stringify({ error: 'assinatura inválida' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  });
}

// ── VALIDA A ASSINATURA (x-signature) DO MERCADO PAGO ──
// Prova que a notificação veio MESMO do Mercado Pago e não foi adulterada.
// O MP manda um header "x-signature: ts=...,v1=..." e um "x-request-id".
// A gente remonta o "manifest" no formato exato deles e recalcula o HMAC-SHA256
// com a assinatura secreta. Se bater com o v1, é autêntico.
function assinaturaValida(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sem segredo configurado → não bloqueia (degrada com elegância)

  const xSignature = req.headers.get('x-signature') || '';
  const xRequestId = req.headers.get('x-request-id') || '';
  if (!xSignature) return false;

  let ts = null, v1 = null;
  for (const part of xSignature.split(',')) {
    const [k, v] = part.split('=', 2);
    if (!k || v === undefined) continue;
    const key = k.trim();
    if (key === 'ts') ts = v.trim();
    else if (key === 'v1') v1 = v.trim();
  }
  if (!ts || !v1) return false;

  // Formato EXATO exigido pelo Mercado Pago (a ordem e os ; importam):
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  // Comparação de tempo constante (evita ataque de timing).
  const a = Buffer.from(esperado);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  // O Mercado Pago pode chamar via POST (corpo JSON) ou GET (query string).
  // Aceitamos os dois e extraímos o ID e o tipo do pagamento.
  let type = '';
  let paymentId = '';

  try {
    const url = new URL(req.url);
    type = url.searchParams.get('type') || url.searchParams.get('topic') || '';
    paymentId = url.searchParams.get('data.id') || url.searchParams.get('id') || '';

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      type = body.type || body.topic || type;
      paymentId = (body.data && body.data.id) || body.id || paymentId;
    }
  } catch (e) {
    console.error('webhook: falha ao ler notificação', e);
    return ok(); // responde 200 mesmo assim, pra não gerar reenvio infinito
  }

  // Só nos interessa notificação de pagamento. Outros tipos (merchant_order
  // etc.) são reconhecidos e ignorados com 200.
  if (type && type !== 'payment') {
    console.log('webhook: tipo ignorado (' + type + ')');
    return ok();
  }
  if (!paymentId) {
    console.log('webhook: sem payment id, ignorando');
    return ok();
  }

  // ── SEGURANÇA: confirma que a notificação é autêntica (veio do Mercado Pago) ──
  if (!assinaturaValida(req, paymentId)) {
    console.warn('webhook: assinatura inválida — notificação REJEITADA (possível impostor).');
    return unauthorized();
  }

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!ACCESS_TOKEN) {
    console.error('webhook: MP_ACCESS_TOKEN não configurado');
    return ok();
  }

  try {
    // ── PASSO-CHAVE: pergunta ao Mercado Pago o status REAL do pagamento ──
    const resp = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
      headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN },
    });

    if (!resp.ok) {
      console.error('webhook: não consegui consultar o pagamento', paymentId, resp.status);
      return ok();
    }

    const pay = await resp.json();
    const status = pay.status;                    // approved | pending | rejected | ...
    const valor = pay.transaction_amount;
    const ref = pay.external_reference || '';     // "nes-..." que criamos na preferência
    const emailComprador = pay.payer && pay.payer.email;

    console.log(`webhook: pagamento ${paymentId} | status=${status} | ref=${ref} | R$${valor}`);

    if (status === 'approved') {
      // ✅ AQUI é o ponto de verdade. Só agora temos certeza de que o dinheiro caiu.
      // É daqui que vai partir, quando plugarmos: e-mail de confirmação, marcação
      // do pedido como pago, aviso ao fornecedor e baixa no STOCK.
      //
      // POR ENQUANTO (webhook rodando sozinho): só registramos de forma bem
      // visível no log, pra confirmar no teste que a mecânica funciona.
      // O e-mail é a PRÓXIMA peça — quando existir, é só descomentar abaixo.
      console.log('✅✅ PAGAMENTO CONFIRMADO E APROVADO ✅✅ ' +
        `ref=${ref} | R$${valor} | pagador=${emailComprador} | id=${paymentId}`);

      // const baseUrl = process.env.URL || '';
      // await dispararEmailConfirmacao(baseUrl, { ref, valor, email: emailComprador, paymentId });
    } else {
      // pending, rejected, in_process... — não confirmamos nada.
      console.log('webhook: pagamento não aprovado (status=' + status + '), nenhuma ação.');
    }

    return ok();
  } catch (e) {
    console.error('webhook: erro ao processar', e);
    return ok();
  }
};

// Dispara o e-mail de confirmação (à prova de falha — nunca derruba o webhook).
async function dispararEmailConfirmacao(baseUrl, dados) {
  if (!baseUrl) return;
  try {
    await fetch(baseUrl + '/.netlify/functions/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
  } catch (e) {
    console.error('webhook: falha ao disparar e-mail (ignorado)', e);
  }
}
