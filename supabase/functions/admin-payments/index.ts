// supabase/functions/admin-payments/index.ts
// Edge Function administrativa de gerenciamento unificado de pagamentos NekoAI

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept, x-requested-with",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToString(base64Url: string): string {
  const bytes = base64UrlToUint8Array(base64Url);
  return new TextDecoder().decode(bytes);
}

async function verifyAdminToken(authHeader: string | null, adminSecret: string): Promise<{ valid: boolean; reason?: string }> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { valid: false, reason: "Header Authorization ausente ou sem formato Bearer" };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Token com formato inválido (deve conter 2 segmentos)" };
  }

  const [b64Payload, b64Sig] = parts;
  const encoder = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(adminSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = base64UrlToUint8Array(b64Sig);
    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(b64Payload));

    if (!isValid) {
      return { valid: false, reason: "Assinatura HMAC do token inválida" };
    }

    const payloadJson = base64UrlToString(b64Payload);
    const payload = JSON.parse(payloadJson);
    const now = Math.floor(Date.now() / 1000);
    
    if (typeof payload.exp !== "number" || payload.exp < now) {
      return { valid: false, reason: `Token expirado (exp: ${payload.exp}, now: ${now})` };
    }
    if (payload.role !== "neko_admin") {
      return { valid: false, reason: `Role incorreta: ${payload.role}` };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Exceção na decodificação do token: ${err?.message || err}` };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const authCheck = await verifyAdminToken(authHeader, adminSecret);
  if (!authCheck.valid) {
    return json({ ok: false, message: `Não autorizado: ${authCheck.reason}` }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const search = url.searchParams.get("search")?.trim().toLowerCase() || "";
      const statusFilter = url.searchParams.get("status")?.trim().toLowerCase() || "all";
      const dateFrom = url.searchParams.get("date_from")?.trim() || "";
      const dateTo = url.searchParams.get("date_to")?.trim() || "";
      const pageStr = url.searchParams.get("page");
      const limitStr = url.searchParams.get("limit");

      const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
      const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

      // Buscar pagamentos de revendas (somente os que têm mp_payment_id)
      const { data: salesRes } = await supabaseAdmin
        .from("reseller_sales")
        .select("id, reseller_id, mp_payment_id, resale_price_snapshot, status, customer_name, customer_email, paid_at, created_at")
        .not("mp_payment_id", "is", null)
        .order("created_at", { ascending: false });

      // Buscar eventos de pagamento de vendas diretas (Apenas eventos que representam uma transação financeira)
      const { data: billingRes } = await supabaseAdmin
        .from("billing_idempotency")
        .select("id, provider, provider_event_id, event_type, status, payload, created_at, updated_at")
        .in("event_type", ["payment_approved", "subscription_renewed", "refund", "chargeback"])
        .order("created_at", { ascending: true }); // Ascendente para processar linha do tempo de transações

      // Buscar nomes de revendedores para enriquecimento
      const { data: resellersRes } = await supabaseAdmin
        .from("resellers")
        .select("id, name");
      
      const resellerMap = new Map<string, string>();
      (resellersRes || []).forEach((r: any) => resellerMap.set(r.id, r.name));

      const unifiedPayments: any[] = [];

      // 1. Processar pagamentos via revenda
      (salesRes || []).forEach((s: any) => {
        let mappedStatus = s.status;
        if (s.status === "license_delivered") mappedStatus = "paid";
        
        unifiedPayments.push({
          id: s.mp_payment_id,
          internal_id: s.id,
          provider: "mercadopago",
          type: "reseller_sale",
          reseller_name: resellerMap.get(s.reseller_id) || "Revendedor",
          customer_name: s.customer_name || "—",
          customer_email: s.customer_email || "—",
          amount: Number(s.resale_price_snapshot || 0),
          method: "pix",
          status: mappedStatus, // pending, paid, cancelled, expired, etc
          paid_at: s.paid_at,
          created_at: s.created_at,
        });
      });

      // 2. Processar eventos de pagamento diretos (SyncPay/Cakto) deduplicados por transação
      const directPaymentsMap = new Map<string, any>();

      (billingRes || []).forEach((b: any) => {
        const payload = b.payload || {};
        const transactionId = payload.transaction_id || b.provider_event_id;
        
        let amount = Number(payload.amount || payload.transaction_amount || 0);
        
        let eventStatus = "pending";
        if (b.status === "completed") {
          if (b.event_type === "chargeback") {
            eventStatus = "chargeback";
          } else if (b.event_type === "refund") {
            eventStatus = "refunded";
          } else {
            eventStatus = "paid";
          }
        } else if (b.status === "failed") {
          eventStatus = "cancelled";
        }

        if (directPaymentsMap.has(transactionId)) {
          const existing = directPaymentsMap.get(transactionId);
          existing.status = eventStatus;
          existing.updated_at = b.updated_at;
          // Se for uma evolução para refund/chargeback, atualiza a data de pagamento/estorno
          if (eventStatus === "refunded" || eventStatus === "chargeback") {
            existing.paid_at = b.updated_at;
          }
        } else {
          directPaymentsMap.set(transactionId, {
            id: transactionId, // Referência principal é a transação financeira
            internal_id: b.id, // ID técnico continua para rastreabilidade 
            provider: b.provider || "direct",
            type: "direct_sale",
            reseller_name: "NekoAI (Direto)",
            customer_name: payload.customer_name || payload.customer?.name || "—",
            customer_email: payload.customer_email || payload.customer?.email || "—",
            amount: amount,
            method: payload.payment_method || "credit_card",
            status: eventStatus,
            paid_at: eventStatus === "paid" ? b.updated_at : null,
            created_at: b.created_at,
          });
        }
      });

      // Consolida transações diretas normalizadas
      unifiedPayments.push(...Array.from(directPaymentsMap.values()));

      // 3. Aplicar filtros
      let filtered = unifiedPayments;

      if (search) {
        filtered = filtered.filter((p) => {
          return (
            (p.customer_name || "").toLowerCase().includes(search) ||
            (p.customer_email || "").toLowerCase().includes(search) ||
            (p.id || "").toLowerCase().includes(search) ||
            (p.reseller_name || "").toLowerCase().includes(search)
          );
        });
      }

      if (statusFilter !== "all") {
        if (statusFilter === "approved") {
          filtered = filtered.filter((p) => p.status === "paid");
        } else {
          filtered = filtered.filter((p) => p.status === statusFilter);
        }
      }

      if (dateFrom) {
        const fromTime = new Date(dateFrom).getTime();
        filtered = filtered.filter((p) => new Date(p.created_at).getTime() >= fromTime);
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        const toTime = toDate.getTime();
        filtered = filtered.filter((p) => new Date(p.created_at).getTime() <= toTime);
      }

      // 4. Calcular métricas unificadas (Apenas em cima das transações finais e deduplicadas)
      const totalPaymentsCount = filtered.length;
      let approvedCount = 0;
      let pendingCount = 0;
      let totalReceived = 0;

      filtered.forEach((p) => {
        if (p.status === "paid") {
          approvedCount++;
          totalReceived += p.amount;
        } else if (p.status === "pending" || p.status === "awaiting_customer") {
          pendingCount++;
        }
      });

      // 5. Ordenar e paginar
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      
      const totalItems = filtered.length;
      const totalPages = Math.ceil(totalItems / limit) || 1;
      const startIndex = (page - 1) * limit;
      const paginatedPayments = filtered.slice(startIndex, startIndex + limit);

      return json({
        ok: true,
        payments: paginatedPayments,
        stats: {
          total_count: totalPaymentsCount,
          approved_count: approvedCount,
          pending_count: pendingCount,
          total_received: totalReceived,
        },
        pagination: {
          page,
          limit,
          total_items: totalItems,
          total_pages: totalPages,
        },
      });
    }

    return json({ ok: false, message: "Método não suportado." }, 405);
  } catch (err: any) {
    console.error("[admin-payments] Erro interno:", err);
    return json({ ok: false, message: `Erro interno: ${err?.message || err}` }, 500);
  }
});
