// supabase/functions/_shared/billing/cakto-adapter.ts
// Adapter oficial da Cakto para normalização de webhooks e validação de secret (Modo Objeto e Modo Agrupado/Array)

import { ProviderAdapter, NormalizedBillingEvent, StandardBillingEventType, BillingItem } from "./types.ts";

export class CaktoAdapter implements ProviderAdapter {
  public providerName = "cakto" as const;

  /**
   * Valida o secret da Cakto enviado no corpo do webhook contra a variável CAKTO_WEBHOOK_SECRET.
   * A validação utiliza comparação em tempo constante para evitar timing attacks.
   */
  public async verifyWebhookSignature(_headers: Headers, rawBody: string, secret: string): Promise<boolean> {
    if (!secret || typeof secret !== "string" || !rawBody) {
      return false;
    }

    try {
      const payload = JSON.parse(rawBody);
      const incomingSecret = payload?.secret;

      if (!incomingSecret || typeof incomingSecret !== "string") {
        return false;
      }

      // Comparação constante
      const encoder = new TextEncoder();
      const a = encoder.encode(incomingSecret);
      const b = encoder.encode(secret);

      if (a.byteLength !== b.byteLength) {
        return false;
      }

      let diff = 0;
      for (let i = 0; i < a.byteLength; i++) {
        diff |= a[i] ^ b[i];
      }

      return diff === 0;
    } catch {
      return false;
    }
  }

  /**
   * Converte o payload JSON bruto da Cakto (objeto único ou array agrupado) em um NormalizedBillingEvent canônico.
   */
  public async parseAndNormalize(_headers: Headers, rawBody: string): Promise<NormalizedBillingEvent> {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error("Payload não é um JSON válido.");
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Payload da Cakto malformado.");
    }

    const eventName = (payload.event || "").trim().toLowerCase();

    // 1. Extração Polimórfica: Suporte a data como Array (Modo Agrupado) ou data como Objeto (Legado/Individual)
    let mainItem: any = null;
    const bumpItems: any[] = [];

    if (Array.isArray(payload.data)) {
      if (payload.data.length === 0) {
        throw new Error("Payload da Cakto contém array de dados vazio.");
      }

      for (const item of payload.data) {
        if (!item || typeof item !== "object") continue;

        if (item.offer_type === "main") {
          mainItem = item;
        } else if (item.offer_type === "orderbump") {
          bumpItems.push(item);
        }
      }

      // Fallback para array sem offer_type explícito: o primeiro item é o principal
      if (!mainItem && payload.data.length > 0) {
        mainItem = payload.data[0];
        for (let i = 1; i < payload.data.length; i++) {
          if (payload.data[i] && typeof payload.data[i] === "object") {
            bumpItems.push(payload.data[i]);
          }
        }
      }
    } else if (payload.data && typeof payload.data === "object") {
      mainItem = payload.data;
      if (Array.isArray(payload.data.order_bumps)) {
        for (const b of payload.data.order_bumps) {
          if (b && typeof b === "object") {
            bumpItems.push(b);
          }
        }
      }
    }

    if (!mainItem) {
      throw new Error("Produto principal não encontrado no payload da Cakto.");
    }

    // 2. ID do evento e transação com validação estrita (NÃO usar randomUUID)
    const eventId = mainItem.id || mainItem.refId;
    if (!eventId || typeof eventId !== "string" || !eventId.trim()) {
      throw new Error("Identificador do evento (id ou refId) ausente no produto principal da Cakto.");
    }

    const transactionId = mainItem.refId || mainItem.id || "";
    const occurredAt = mainItem.paidAt || mainItem.createdAt || mainItem.paid_at || mainItem.created_at || new Date().toISOString();

    const subscription = mainItem.subscription || null;
    const subscriptionId = subscription?.id || null;

    // 3. Mapeamento de Status do Evento Cakto para StandardBillingEventType
    let standardEventType: StandardBillingEventType;

    if (eventName === "purchase_approved") {
      if (subscriptionId) {
        standardEventType = "subscription_created";
      } else {
        standardEventType = "payment_approved";
      }
    } else if (eventName === "subscription_renewed") {
      standardEventType = "subscription_renewed";
    } else if (eventName === "subscription_canceled") {
      standardEventType = "subscription_canceled";
    } else if (eventName === "refund") {
      standardEventType = "refund";
    } else if (eventName === "chargeback") {
      standardEventType = "chargeback";
    } else if (eventName === "purchase_refused") {
      standardEventType = "payment_failed";
    } else {
      standardEventType = "payment_failed";
    }

    // 4. Extração e sanitização dos dados do cliente (suporte a docNumber e document)
    const customerObj = mainItem.customer || {};
    const rawName = customerObj.name || null;
    const rawEmail = customerObj.email || null;
    const rawPhone = customerObj.phone || customerObj.cellphone || null;
    const rawDocument = customerObj.docNumber || customerObj.document || null;

    const customer = {
      name: typeof rawName === "string" ? rawName.trim().slice(0, 128) : null,
      email: typeof rawEmail === "string" ? rawEmail.trim().toLowerCase().slice(0, 255) : null,
      phone: typeof rawPhone === "string" ? rawPhone.replace(/\s+/g, "").slice(0, 32) : null,
      document: typeof rawDocument === "string" ? rawDocument.trim() : null,
    };

    // 5. Extração dos Itens: Produto Base e Order Bumps (mantendo product.id)
    const items: BillingItem[] = [];
    let mainProductId: string | null = null;

    if (mainItem.product && mainItem.product.id) {
      mainProductId = mainItem.product.id;
      items.push({
        id: mainItem.product.id,
        name: mainItem.product.name || "Produto Principal",
        type: "product",
        amount: mainItem.amount || mainItem.baseAmount,
      });
    }

    for (const bump of bumpItems) {
      const bumpId = bump.product?.id || bump.id;
      if (bumpId) {
        items.push({
          id: bumpId,
          name: bump.product?.name || bump.name || "Order Bump Adicional",
          type: "order_bump",
          amount: bump.amount || bump.price,
        });
      }
    }

    // 6. Cálculo de valor total consolidado
    let totalAmount = typeof mainItem.amount === "number" ? mainItem.amount : typeof mainItem.price === "number" ? mainItem.price : 0;
    for (const b of bumpItems) {
      const bAmt = typeof b.amount === "number" ? b.amount : typeof b.price === "number" ? b.price : 0;
      totalAmount += bAmt;
    }

    const currency = mainItem.currency || "BRL";

    return {
      provider: this.providerName,
      provider_event_id: eventId,
      event_type: standardEventType,
      transaction_id: transactionId,
      subscription_id: subscriptionId,
      customer,
      product_id: mainProductId,
      items,
      amount: totalAmount,
      currency,
      occurred_at: occurredAt,
      raw_metadata: {
        event_name: payload.event,
        ref_id: mainItem.refId,
        payment_method: mainItem.paymentMethod || mainItem.payment_method,
        payment_method_name: mainItem.paymentMethodName,
        status: mainItem.status,
        subscription,
        grouped_order_bumps_count: bumpItems.length,
      },
    };
  }
}
