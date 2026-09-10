// supabase/functions/_shared/billing/types.ts
// Tipos canônicos e contratos agnósticos para a arquitetura de Billing do NekoAI

export type LicensePlan = "MONTHLY" | "QUARTERLY" | "ANNUAL";

export type BillingProvider = "syncpay" | "cakto" | "stripe" | "manual";

export type StandardBillingEventType =
  | "payment_approved"       // Venda avulsa ou 1º ciclo aprovado
  | "payment_failed"         // Tentativa de pagamento falhou / recusada
  | "subscription_created"   // Assinatura iniciada
  | "subscription_renewed"   // Ciclo recorrente subsequente pago
  | "subscription_canceled"  // Assinatura cancelada
  | "subscription_overdue"   // Cobrança em atraso (grace period)
  | "refund"                 // Estorno/Reembolso financeiro
  | "chargeback";            // Contestação de compra / fraude

export interface BillingCustomer {
  name: string | null;
  email: string | null;
  phone: string | null;
  document?: string | null;
}

export interface BillingItem {
  id: string; // reference_id estável do produto ou order_bump no gateway
  name: string;
  type: "product" | "order_bump" | "unknown";
  amount?: number;
}

export interface NormalizedBillingEvent {
  provider: BillingProvider;
  provider_event_id: string;
  event_type: StandardBillingEventType;
  transaction_id: string;
  subscription_id?: string | null;
  customer: BillingCustomer;
  product_id?: string | null;
  items: BillingItem[];
  amount: number;
  currency: string;
  occurred_at: string; // ISO 8601 UTC
  raw_metadata?: Record<string, unknown>;
}

export interface ProductCatalogEntry {
  provider_product_id: string;
  plan: LicensePlan;
  duration_days: number;
  base_devices: number;
}

export interface OrderBumpCatalogEntry {
  provider_bump_id: string;
  additional_devices: number;
}

export interface BillingCatalogConfig {
  products: Record<string, ProductCatalogEntry>;
  order_bumps: Record<string, OrderBumpCatalogEntry>;
}

export interface LicenseCreationResult {
  license_id: string;
  plain_key: string;
  key_mask: string;
  plan: LicensePlan;
  max_devices: number;
  expires_at: string;
  status: string;
}

export interface BillingCoreResult {
  ok: boolean;
  action_performed: "license_created" | "license_renewed" | "license_revoked" | "status_updated" | "ignored" | "already_processed";
  license_id?: string;
  key_mask?: string;
  plain_key?: string; // Disponível apenas quando nova licença for gerada para envio
  email_sent?: boolean;
  email_id?: string;
  email_error?: string;
  message: string;
  error_code?: string;
}

export interface ProviderAdapter {
  providerName: BillingProvider;
  verifyWebhookSignature(headers: Headers, rawBody: string, secret: string): Promise<boolean>;
  parseAndNormalize(headers: Headers, rawBody: string): Promise<NormalizedBillingEvent>;
}
