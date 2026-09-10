// supabase/functions/_shared/billing/billing-core.ts
// Núcleo agnóstico de regras de negócio, ciclo de vida de licenças e idempotência do NekoAI

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  NormalizedBillingEvent,
  BillingCoreResult,
  LicensePlan,
  BillingCatalogConfig,
} from "./types.ts";
import { BILLING_CATALOG } from "./catalog.ts";
import { emailClient } from "./email-client.ts";

/**
 * Alfabeto Base32 oficial do NekoAI para geração de chaves legíveis.
 */
const LICENSE_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Gera uma chave criptográfica no formato NEKO-XXXX-XXXX-XXXX-XXXX.
 */
export function generateLicenseKey(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);

  const groups: string[] = [];
  let byteIndex = 0;
  for (let g = 0; g < 4; g++) {
    let groupStr = "";
    for (let c = 0; c < 4; c++) {
      const randomValue = randomBytes[byteIndex++];
      const charIndex = randomValue % LICENSE_CHARSET.length;
      groupStr += LICENSE_CHARSET[charIndex];
    }
    groups.push(groupStr);
  }

  return `NEKO-${groups.join("-")}`;
}

/**
 * Calcula o hash SHA-256 da chave de licença em maiúsculo.
 */
export async function calculateSha256(text: string): Promise<string> {
  const normalized = text.trim().toUpperCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deriva a máscara pública NEKO-****-****-****-XXXX.
 */
export function extractKeyMask(licenseKey: string): string {
  const clean = licenseKey.trim().toUpperCase();
  const lastFour = clean.slice(-4);
  return `NEKO-****-****-****-${lastFour}`;
}

/**
 * Deriva chave simétrica AES-GCM a partir do segredo administrativo via SHA-256.
 */
async function getAesGcmKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Criptografa a chave em texto plano com AES-GCM (12-byte IV + ciphertext em base64).
 */
export async function encryptLicenseKey(plainKey: string, secret: string): Promise<string> {
  const key = await getAesGcmKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainKey.trim().toUpperCase())
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  let binary = "";
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

export class BillingCore {
  private supabase: SupabaseClient;

  constructor(supabaseClient: SupabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Ponto de entrada centralizado para processamento de eventos de billing.
   */
  public async processEvent(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    // 1. Verificação e Lock de Idempotência
    const isIdempotent = await this.acquireIdempotencyLock(event);
    if (!isIdempotent) {
      return {
        ok: true,
        action_performed: "already_processed",
        message: `Evento ${event.provider_event_id} já foi processado anteriormente.`,
      };
    }

    try {
      let result: BillingCoreResult;

      switch (event.event_type) {
        case "payment_approved":
        case "subscription_created":
          result = await this.handlePaymentApproved(event);
          break;

        case "subscription_renewed":
          result = await this.handleSubscriptionRenewed(event);
          break;

        case "subscription_canceled":
          result = await this.handleSubscriptionCanceled(event);
          break;

        case "subscription_overdue":
        case "payment_failed":
          result = await this.handlePaymentFailed(event);
          break;

        case "refund":
        case "chargeback":
          result = await this.handleRefundOrChargeback(event);
          break;

        default:
          result = {
            ok: true,
            action_performed: "ignored",
            message: `Evento do tipo ${event.event_type} não exige ação sobre licenças.`,
          };
      }

      // Conclui o registro de idempotência
      await this.completeIdempotency(event.provider, event.provider_event_id, "completed");
      return result;
    } catch (err: any) {
      await this.completeIdempotency(event.provider, event.provider_event_id, "failed");
      throw err;
    }
  }

  /**
   * 1. Processa Compra Aprovada / 1º Ciclo: Cria licença com capacidade somada.
   */
  private async handlePaymentApproved(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    const catalog = BILLING_CATALOG[event.provider] || { products: {}, order_bumps: {} };

    // Identifica o Produto Principal
    let matchedProduct = event.product_id ? catalog.products[event.product_id] : null;

    // Fallback: se não veio product_id direto, busca nos items
    if (!matchedProduct && event.items.length > 0) {
      for (const it of event.items) {
        if (catalog.products[it.id]) {
          matchedProduct = catalog.products[it.id];
          break;
        }
      }
    }

    if (!matchedProduct) {
      return {
        ok: false,
        action_performed: "ignored",
        error_code: "PRODUCT_NOT_RECOGNIZED",
        message: `Nenhum produto cadastrado no catálogo foi encontrado no payload para o item ${event.product_id || "desconhecido"}.`,
      };
    }

    // Identifica Order Bumps e calcula a capacidade total (Base + Soma dos Bumps)
    let totalMaxDevices = matchedProduct.base_devices || 1;

    for (const it of event.items) {
      if (it.type === "order_bump" || catalog.order_bumps[it.id]) {
        const bumpConfig = catalog.order_bumps[it.id];
        if (bumpConfig) {
          totalMaxDevices += bumpConfig.additional_devices;
        } else {
          console.warn(`[BillingCore] Order bump desconhecido no catálogo: ${it.id}. Ignorando dispositivos extras deste bump.`);
        }
      }
    }

    // Limite de segurança (1 a 100)
    totalMaxDevices = Math.min(Math.max(totalMaxDevices, 1), 100);

    // Calcula expiração
    const now = new Date();
    const expiresAt = new Date(now.getTime() + matchedProduct.duration_days * 24 * 60 * 60 * 1000);

    // Gera a chave criptográfica
    const plainKey = generateLicenseKey();
    const keyHash = await calculateSha256(plainKey);
    const keyMask = extractKeyMask(plainKey);

    const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");
    let encryptedKey: string | null = null;
    if (adminSecret) {
      try {
        encryptedKey = await encryptLicenseKey(plainKey, adminSecret);
      } catch (encErr) {
        console.warn("[BillingCore] Falha ao criptografar chave para armazenamento:", encErr);
      }
    }

    const defaultEntitlements = [
      "agent_execution",
      "preview_server",
      "file_manipulation",
      "cloud_supabase",
      "cloud_github",
      "cloud_vercel",
    ];

    // Insere na tabela public.licenses
    const { data: newLicense, error: licErr } = await this.supabase
      .from("licenses")
      .insert({
        user_id: null,
        key_hash: keyHash,
        key_mask: keyMask,
        plan: matchedProduct.plan,
        status: "active",
        max_devices: totalMaxDevices,
        customer_name: event.customer.name,
        customer_email: event.customer.email,
        customer_whatsapp: event.customer.phone,
        provider: event.provider,
        provider_customer_id: event.customer.email || null,
        provider_subscription_id: event.subscription_id || null,
        expires_at: expiresAt.toISOString(),
        entitlements: defaultEntitlements,
        encrypted_key: encryptedKey,
      })
      .select()
      .single();

    if (licErr) {
      throw new Error(`Erro ao persistir licença no banco: ${licErr.message}`);
    }

    // Se houver vínculo de assinatura recorrente, registra em billing_subscriptions
    if (event.subscription_id) {
      await this.supabase.from("billing_subscriptions").insert({
        license_id: newLicense.id,
        provider: event.provider,
        provider_subscription_id: event.subscription_id,
        provider_customer_id: event.customer.email || null,
        plan: matchedProduct.plan,
        status: "active",
        next_charge_at: expiresAt.toISOString(),
      });
    }

    // Auditoria em license_events
    await this.supabase.from("license_events").insert({
      license_id: newLicense.id,
      device_id: "00000000000000000000000000000000",
      event_type: "activate",
      metadata: {
        billing_action: "payment_approved",
        provider: event.provider,
        transaction_id: event.transaction_id,
        subscription_id: event.subscription_id,
        plan: matchedProduct.plan,
        max_devices: totalMaxDevices,
        customer_email: event.customer.email,
      },
    });

    // 6. Disparo Automático de E-mail de Acesso com a Chave de Licença
    let emailSent = false;
    let emailId: string | undefined;
    let emailError: string | undefined;

    if (event.customer.email) {
      try {
        const emailResult = await emailClient.sendLicenseDelivery({
          customerName: event.customer.name,
          customerEmail: event.customer.email,
          licenseKey: plainKey,
          plan: matchedProduct.plan,
          maxDevices: totalMaxDevices,
        });

        emailSent = emailResult.ok;
        emailId = emailResult.email_id;
        emailError = emailResult.error_code ? `${emailResult.error_code}: ${emailResult.message}` : undefined;

        // Registra evento de auditoria de entrega de e-mail
        await this.supabase.from("license_events").insert({
          license_id: newLicense.id,
          device_id: "00000000000000000000000000000000",
          event_type: emailSent ? "validate" : "failed_attempt",
          metadata: {
            billing_action: emailSent ? "email_delivered" : "email_delivery_failed",
            customer_email: event.customer.email,
            email_id: emailId || null,
            error_code: emailResult.error_code || null,
            error_message: emailResult.message || null,
            delivered_at: new Date().toISOString(),
          },
        });
      } catch (emailErr: any) {
        emailError = emailErr?.message || "Exceção inesperada no envio de e-mail";
        console.error("[BillingCore] Erro não tratado ao despachar e-mail de licença:", emailErr);
      }
    }

    return {
      ok: true,
      action_performed: "license_created",
      license_id: newLicense.id,
      key_mask: keyMask,
      plain_key: plainKey,
      email_sent: emailSent,
      email_id: emailId,
      email_error: emailError,
      message: `Licença ${keyMask} criada com sucesso para ${event.customer.email || "cliente"} (${totalMaxDevices} dispositivos).${emailSent ? " E-mail de acesso enviado com sucesso." : ""}`,
    };
  }

  /**
   * 2. Processa Renovação de Assinatura: Estende expires_at da mesma licença.
   */
  private async handleSubscriptionRenewed(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    if (!event.subscription_id) {
      return { ok: false, action_performed: "ignored", message: "ID de assinatura ausente na renovação." };
    }

    // Busca a licença vinculada
    const { data: license, error: fetchErr } = await this.supabase
      .from("licenses")
      .select("*")
      .eq("provider", event.provider)
      .eq("provider_subscription_id", event.subscription_id)
      .single();

    if (fetchErr || !license) {
      console.warn(`[BillingCore] Licença para subscription_id ${event.subscription_id} não encontrada para renovação.`);
      return { ok: false, action_performed: "ignored", message: "Licença vinculada à assinatura não foi encontrada." };
    }

    // Define o período de extensão conforme o plano da licença existente
    let extensionDays = 30;
    if (license.plan === "QUARTERLY") extensionDays = 90;
    if (license.plan === "ANNUAL") extensionDays = 365;

    const currentExpiry = new Date(license.expires_at);
    const now = new Date();
    // Se a licença já expirou, estende a partir de agora; se ainda está no prazo, estende a partir da expiração atual
    const baseDate = currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
    const newExpiry = new Date(baseDate.getTime() + extensionDays * 24 * 60 * 60 * 1000);

    const { error: updateErr } = await this.supabase
      .from("licenses")
      .update({
        status: "active",
        expires_at: newExpiry.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", license.id);

    if (updateErr) {
      throw new Error(`Erro ao renovar licença: ${updateErr.message}`);
    }

    // Atualiza tabela de assinaturas se existir
    await this.supabase
      .from("billing_subscriptions")
      .update({
        status: "active",
        next_charge_at: newExpiry.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("provider", event.provider)
      .eq("provider_subscription_id", event.subscription_id);

    // Auditoria
    await this.supabase.from("license_events").insert({
      license_id: license.id,
      device_id: "00000000000000000000000000000000",
      event_type: "activate",
      metadata: {
        billing_action: "subscription_renewed",
        provider: event.provider,
        transaction_id: event.transaction_id,
        subscription_id: event.subscription_id,
        new_expires_at: newExpiry.toISOString(),
      },
    });

    return {
      ok: true,
      action_performed: "license_renewed",
      license_id: license.id,
      key_mask: license.key_mask,
      message: `Licença ${license.key_mask} renovada até ${newExpiry.toLocaleDateString("pt-BR")}.`,
    };
  }

  /**
   * 3. Processa Cancelamento de Assinatura: Mantém licença ativa até o fim de expires_at.
   */
  private async handleSubscriptionCanceled(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    if (!event.subscription_id) {
      return { ok: false, action_performed: "ignored", message: "ID de assinatura ausente." };
    }

    // Atualiza apenas o status da tabela de assinaturas (a licença continua ativa até expires_at)
    await this.supabase
      .from("billing_subscriptions")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("provider", event.provider)
      .eq("provider_subscription_id", event.subscription_id);

    const { data: license } = await this.supabase
      .from("licenses")
      .select("id, key_mask, expires_at")
      .eq("provider", event.provider)
      .eq("provider_subscription_id", event.subscription_id)
      .single();

    if (license) {
      await this.supabase.from("license_events").insert({
        license_id: license.id,
        device_id: "00000000000000000000000000000000",
        event_type: "validate",
        metadata: {
          billing_action: "subscription_canceled",
          provider: event.provider,
          subscription_id: event.subscription_id,
          note: `Assinatura cancelada no gateway. Acesso mantido até ${license.expires_at}.`,
        },
      });
    }

    return {
      ok: true,
      action_performed: "status_updated",
      license_id: license?.id,
      message: "Cancelamento registrado. Licença permanece ativa até a data de vencimento.",
    };
  }

  /**
   * 4. Processa Falha de Pagamento / Inadimplência temporária (Grace period).
   */
  private async handlePaymentFailed(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    if (!event.subscription_id) {
      return { ok: true, action_performed: "ignored", message: "Falha de pagamento avulsa ignorada." };
    }

    await this.supabase
      .from("billing_subscriptions")
      .update({ status: "overdue", updated_at: new Date().toISOString() })
      .eq("provider", event.provider)
      .eq("provider_subscription_id", event.subscription_id);

    return {
      ok: true,
      action_performed: "status_updated",
      message: "Status de assinatura atualizado para overdue.",
    };
  }

  /**
   * 5. Processa Reembolso / Chargeback: Revogação Imediata da Licença.
   */
  private async handleRefundOrChargeback(event: NormalizedBillingEvent): Promise<BillingCoreResult> {
    // Localiza a licença por subscription_id ou pelo e-mail do cliente mais recente
    let query = this.supabase.from("licenses").select("*");

    if (event.subscription_id) {
      query = query.eq("provider", event.provider).eq("provider_subscription_id", event.subscription_id);
    } else if (event.customer.email) {
      query = query.eq("customer_email", event.customer.email).order("created_at", { ascending: false }).limit(1);
    }

    const { data: licenses } = await query;
    const license = Array.isArray(licenses) ? licenses[0] : licenses;

    if (!license) {
      return { ok: false, action_performed: "ignored", message: "Licença para estorno não localizada." };
    }

    // Revoga a licença
    await this.supabase
      .from("licenses")
      .update({
        status: "revoked",
        updated_at: new Date().toISOString(),
      })
      .eq("id", license.id);

    // Desconecta os dispositivos ativos
    await this.supabase.from("license_activations").delete().eq("license_id", license.id);

    // Registra evento de revogação
    await this.supabase.from("license_events").insert({
      license_id: license.id,
      device_id: "00000000000000000000000000000000",
      event_type: "revoke",
      metadata: {
        billing_action: event.event_type,
        provider: event.provider,
        transaction_id: event.transaction_id,
        reason: event.event_type === "chargeback" ? "Contestação de compra (Chargeback)" : "Reembolso aprovado (Refund)",
      },
    });

    return {
      ok: true,
      action_performed: "license_revoked",
      license_id: license.id,
      key_mask: license.key_mask,
      message: `Licença ${license.key_mask} revogada devido a ${event.event_type}.`,
    };
  }

  /**
   * Mecanismo atômico de idempotência via tabela public.billing_idempotency.
   */
  private async acquireIdempotencyLock(event: NormalizedBillingEvent): Promise<boolean> {
    const { error } = await this.supabase.from("billing_idempotency").insert({
      provider: event.provider,
      provider_event_id: event.provider_event_id,
      event_type: event.event_type,
      status: "processing",
      payload: {
        transaction_id: event.transaction_id,
        amount: event.amount,
        customer_email: event.customer.email,
        occurred_at: event.occurred_at,
      },
    });

    if (error) {
      // Violação de constraint de unicidade (código Postgres 23505) = evento já recebido
      if (error.code === "23505" || error.message.includes("duplicate key")) {
        return false;
      }
      console.error("[BillingCore] Erro ao registrar idempotência:", error);
    }

    return true;
  }

  private async completeIdempotency(provider: string, eventId: string, status: "completed" | "failed"): Promise<void> {
    await this.supabase
      .from("billing_idempotency")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("provider", provider)
      .eq("provider_event_id", eventId);
  }
}
