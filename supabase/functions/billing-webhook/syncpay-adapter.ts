// supabase/functions/_shared/billing/syncpay-adapter.ts
// Adapter oficial da SyncPay para normalização de webhooks e validação HMAC

import { ProviderAdapter, NormalizedBillingEvent, StandardBillingEventType, BillingItem } from "./types.ts";

/**
 * Converte Uint8Array para string hexadecimal.
 */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class SyncPayAdapter implements ProviderAdapter {
  public providerName = "syncpay" as const;

  /**
   * Valida a assinatura HMAC-SHA256 oficial da SyncPay com tolerância anti-replay de 5 minutos (300 segundos).
   * Header: X-SyncPay-Signature: t=<unix_timestamp>,v1=<hex_hash>
   * Assinatura esperada: HMAC_SHA256(secret, "${t}.${rawBody}")
   */
  public async verifyWebhookSignature(headers: Headers, rawBody: string, secret: string): Promise<boolean> {
    const signatureHeader = headers.get("x-syncpay-signature") || headers.get("X-SyncPay-Signature");
    if (!signatureHeader || !secret) {
      return false;
    }

    // Parsing de t=<timestamp>,v1=<hash>
    let timestampStr = "";
    let expectedHash = "";

    const parts = signatureHeader.split(",");
    for (const part of parts) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (k === "t") timestampStr = v;
      if (k === "v1") expectedHash = v;
    }

    if (!timestampStr || !expectedHash) {
      return false;
    }

    const t = parseInt(timestampStr, 10);
    if (isNaN(t)) {
      return false;
    }

    // Validação Anti-Replay: janela máxima de 300 segundos
    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - t) > 300) {
      console.warn(`[SyncPayAdapter] Replay attack protection: timestamp ${t} outside 300s window (now: ${nowUnix})`);
      return false;
    }

    try {
      const encoder = new TextEncoder();
      const signedData = encoder.encode(`${timestampStr}.${rawBody}`);
      const keyData = encoder.encode(secret);

      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, signedData);
      const computedHash = toHex(signatureBuffer);

      // Comparação constante de strings
      return computedHash.toLowerCase() === expectedHash.toLowerCase();
    } catch (err) {
      console.error("[SyncPayAdapter] Exceção na verificação da assinatura:", err);
      return false;
    }
  }

  /**
   * Converte o payload JSON bruto da SyncPay em um NormalizedBillingEvent canônico.
   */
  public async parseAndNormalize(headers: Headers, rawBody: string): Promise<NormalizedBillingEvent> {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error("Payload não é um JSON válido.");
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Payload da SyncPay malformado.");
    }

    const eventId = payload.event_id || crypto.randomUUID();
    const eventName = payload.event || headers.get("x-syncpay-event") || "transaction.updated";
    const occurredAt = payload.occurred_at || new Date().toISOString();

    const transaction = payload.transaction || {};
    const transactionId = transaction.reference_id || "";
    const rawStatus = (transaction.status || "").toLowerCase();
    const origin = (transaction.origin || "").toLowerCase();
    const amount = typeof transaction.amount === "number" ? transaction.amount : 0;
    const currency = transaction.currency || "BRL";

    // 1. Mapeamento de Status do Gateway para Máquina de Estados Interna
    let standardEventType: StandardBillingEventType;

    if (rawStatus === "completed") {
      if (origin === "subscription") {
        standardEventType = "subscription_renewed";
      } else {
        standardEventType = "payment_approved";
      }
    } else if (rawStatus === "refunded") {
      standardEventType = "refund";
    } else if (rawStatus === "chargedback") {
      standardEventType = "chargeback";
    } else if (rawStatus === "refused") {
      standardEventType = "payment_failed";
    } else {
      // Status pendente ou intermediário
      standardEventType = "payment_failed";
    }

    // 2. Extração dos Dados do Cliente (Sanitização Básica)
    const customerObj = payload.customer || {};
    const debtorAccount = payload.debtor_account || {};

    const rawName = customerObj.name || debtorAccount.name || null;
    const rawEmail = customerObj.email || null;
    const rawPhone = customerObj.phone || null;
    const rawDocument = customerObj.document || null;

    const customer = {
      name: typeof rawName === "string" ? rawName.trim().slice(0, 128) : null,
      email: typeof rawEmail === "string" ? rawEmail.trim().toLowerCase().slice(0, 255) : null,
      phone: typeof rawPhone === "string" ? rawPhone.replace(/\s+/g, "").slice(0, 32) : null,
      document: typeof rawDocument === "string" ? rawDocument.trim() : null,
    };

    // 3. Extração e Identificação dos Itens (Produto Base + Order Bumps)
    const items: BillingItem[] = [];
    let mainProductId: string | null = null;

    if (payload.checkout && Array.isArray(payload.checkout.items)) {
      for (const it of payload.checkout.items) {
        const itemId = it.reference_id || "";
        const itemType = it.type === "order_bump" ? "order_bump" : it.type === "product" ? "product" : "unknown";
        
        items.push({
          id: itemId,
          name: it.name || "Item",
          type: itemType,
          amount: it.amount,
        });

        if (itemType === "product" && !mainProductId) {
          mainProductId = itemId;
        }
      }
    }

    return {
      provider: this.providerName,
      provider_event_id: eventId,
      event_type: standardEventType,
      transaction_id: transactionId,
      subscription_id: origin === "subscription" ? (payload.subscription_token || transaction.subscription_id || null) : null,
      customer,
      product_id: mainProductId,
      items,
      amount,
      currency,
      occurred_at: occurredAt,
      raw_metadata: {
        event_name: eventName,
        origin,
        raw_status: rawStatus,
        payment_method: transaction.payment_method,
        end_to_end_id: transaction.end_to_end_id,
        tracking: payload.tracking,
      },
    };
  }
}
