// supabase/functions/reseller-api/index.ts
// Edge Function restrita para Operações Comerciais e Checkout PIX de Revendedores

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getOfficialPricing,
  FALLBACK_ADMIN_PRICING,
} from "../_shared/pricing/admin-pricing.ts";
import { emailClient } from "../_shared/email/email-client.ts";
import { encryptLicenseKey, decryptLicenseKey } from "../_shared/license-crypto.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept, x-requested-with",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const OFFICIAL_NEKO_COSTS: Record<string, number> = {
  MONTHLY: FALLBACK_ADMIN_PRICING.MONTHLY.neko_cost,
  QUARTERLY: FALLBACK_ADMIN_PRICING.QUARTERLY.neko_cost,
  ANNUAL: FALLBACK_ADMIN_PRICING.ANNUAL.neko_cost,
};

const DEFAULT_RESALE_PRICES: Record<string, number> = {
  MONTHLY: FALLBACK_ADMIN_PRICING.MONTHLY.suggested_resale_price,
  QUARTERLY: FALLBACK_ADMIN_PRICING.QUARTERLY.suggested_resale_price,
  ANNUAL: FALLBACK_ADMIN_PRICING.ANNUAL.suggested_resale_price,
};

export const PLAN_COMMERCIAL_NAMES: Record<string, string> = {
  MONTHLY: "NekoAI - App Builder Mensal",
  QUARTERLY: "NekoAI - App Builder Trimestral",
  ANNUAL: "NekoAI - App Builder Anual",
};

export function getPlanCommercialName(plan: string): string {
  return PLAN_COMMERCIAL_NAMES[plan] || `NekoAI - App Builder ${plan}`;
}

/**
 * Extrai dados do PIX (Copia e Cola, QR Code Base64 e Ticket URL) da resposta da Orders API do Mercado Pago.
 * Suporta a estrutura canônica (transactions.payments[].point_of_interaction.transaction_data),
 * estruturas legadas na raiz e fallbacks profundos.
 */
export function extractOrderPixData(mpData: any): {
  pixQrCode: string | null;
  pixQrCodeBase64: string | null;
  ticketUrl: string | null;
  orderId: string | null;
  paymentId: string | null;
  status: string | null;
  statusDetail: string | null;
} {
  if (!mpData || typeof mpData !== "object") {
    return {
      pixQrCode: null,
      pixQrCodeBase64: null,
      ticketUrl: null,
      orderId: null,
      paymentId: null,
      status: null,
      statusDetail: null,
    };
  }

  const orderId = mpData.id ? String(mpData.id) : null;
  let paymentId: string | null = null;
  let pixQrCode: string | null = null;
  let pixQrCodeBase64: string | null = null;
  let ticketUrl: string | null = null;
  let status: string | null = mpData.status ? String(mpData.status) : null;
  let statusDetail: string | null = mpData.status_detail ? String(mpData.status_detail) : null;

  // 1. Procurar nas transações de pagamento (estrutura oficial da Orders API: transactions.payments)
  const payments = Array.isArray(mpData.transactions?.payments)
    ? mpData.transactions.payments
    : Array.isArray(mpData.transactions)
    ? mpData.transactions.flatMap((t: any) => t?.payments || (t ? [t] : []))
    : Array.isArray(mpData.payments)
    ? mpData.payments
    : [];

  for (const p of payments) {
    if (!p || typeof p !== "object") continue;

    if (p.id && !paymentId) paymentId = String(p.id);
    if (p.status && !status) status = String(p.status);
    if (p.status_detail && !statusDetail) statusDetail = String(p.status_detail);

    // Prioridade 1: point_of_interaction.transaction_data do pagamento (padrão oficial Mercado Pago)
    const poi = p.point_of_interaction?.transaction_data;
    if (poi?.qr_code && !pixQrCode) pixQrCode = String(poi.qr_code);
    if (poi?.qr_code_base64 && !pixQrCodeBase64) pixQrCodeBase64 = String(poi.qr_code_base64);
    if (poi?.ticket_url && !ticketUrl) ticketUrl = String(poi.ticket_url);

    // Prioridade 2: payment_method do pagamento
    const pm = p.payment_method;
    if (pm?.qr_code && !pixQrCode) pixQrCode = String(pm.qr_code);
    if (pm?.qr_code_base64 && !pixQrCodeBase64) pixQrCodeBase64 = String(pm.qr_code_base64);
    if (pm?.ticket_url && !ticketUrl) ticketUrl = String(pm.ticket_url);

    // Prioridade 3: campos diretos no objeto de pagamento
    if (p.qr_code && !pixQrCode) pixQrCode = String(p.qr_code);
    if (p.qr_code_base64 && !pixQrCodeBase64) pixQrCodeBase64 = String(p.qr_code_base64);
    if (p.ticket_url && !ticketUrl) ticketUrl = String(p.ticket_url);
  }

  // 2. Prioridade 4: point_of_interaction na raiz da Order
  const rootPoi = mpData.point_of_interaction?.transaction_data;
  if (rootPoi?.qr_code && !pixQrCode) pixQrCode = String(rootPoi.qr_code);
  if (rootPoi?.qr_code_base64 && !pixQrCodeBase64) pixQrCodeBase64 = String(rootPoi.qr_code_base64);
  if (rootPoi?.ticket_url && !ticketUrl) ticketUrl = String(rootPoi.ticket_url);

  // 3. Prioridade 5: qr_data na raiz (modelo QR dinâmico)
  if (mpData.qr_data && !pixQrCode) {
    pixQrCode = String(mpData.qr_data);
  }

  // 4. Busca profunda de contingência (fallback profundo em toda a árvore de propriedades)
  if (!pixQrCode || !pixQrCodeBase64) {
    const deepFind = (obj: any, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 5) return;
      if (Array.isArray(obj)) {
        for (const item of obj) deepFind(item, depth + 1);
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (!pixQrCode && (k === "qr_code" || k === "qr_data") && typeof v === "string" && v.length >= 20) {
          pixQrCode = v;
        }
        if (!pixQrCodeBase64 && k === "qr_code_base64" && typeof v === "string" && v.length >= 30) {
          pixQrCodeBase64 = v;
        }
        if (!ticketUrl && k === "ticket_url" && typeof v === "string" && v.startsWith("http")) {
          ticketUrl = v;
        }
        if (v && typeof v === "object") {
          deepFind(v, depth + 1);
        }
      }
    };
    deepFind(mpData);
  }

  return { pixQrCode, pixQrCodeBase64, ticketUrl, orderId, paymentId, status, statusDetail };
}

function maskCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
  }
  return "***";
}

function sanitizeForDiagnostics(data: any, depth = 0): any {
  if (depth > 6 || data === null || data === undefined) return data;
  if (typeof data === "string") {
    if (
      data.startsWith("APP_USR-") ||
      data.startsWith("TEST-") ||
      (data.length > 50 && !data.startsWith("000201") && !data.startsWith("iVBORw0KGgo"))
    ) {
      return "[REDACTED_SECRET]";
    }
    const digits = data.replace(/\D/g, "");
    if (digits.length === 11 && (data.includes(".") || data.length === 11)) {
      return maskCpf(digits);
    }
    return data;
  }
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForDiagnostics(item, depth + 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("auth") ||
      lowerKey === "authorization"
    ) {
      sanitized[key] = "[REDACTED]";
    } else if (lowerKey === "identification" && value && typeof value === "object") {
      sanitized[key] = {
        type: (value as any).type,
        number: typeof (value as any).number === "string" ? maskCpf((value as any).number) : "***",
      };
    } else if (lowerKey === "number" && typeof value === "string" && value.replace(/\D/g, "").length === 11) {
      sanitized[key] = maskCpf(value);
    } else {
      sanitized[key] = sanitizeForDiagnostics(value, depth + 1);
    }
  }
  return sanitized;
}

function extractMercadoPagoErrorDetails(mpData: any, status?: number): string {
  if (!mpData) {
    return status ? `Status HTTP ${status}` : "Resposta vazia do Mercado Pago";
  }
  if (typeof mpData === "string") {
    const cleaned = mpData.replace(/<[^>]*>?/gm, "").trim();
    return cleaned.slice(0, 300) || (status ? `Status HTTP ${status}` : "Erro desconhecido");
  }

  const parts: string[] = [];

  // 1. Process cause (Mercado Pago v1 error schema)
  if (Array.isArray(mpData.cause) && mpData.cause.length > 0) {
    const causes = mpData.cause.map((c: any) => {
      if (!c) return "";
      if (typeof c === "string") return c;
      const desc = c.description || c.message || "";
      const code = c.code ? `[${c.code}]` : "";
      return [code, desc].filter(Boolean).join(" ");
    }).filter(Boolean);
    if (causes.length > 0) {
      parts.push(causes.join("; "));
    }
  } else if (mpData.cause && typeof mpData.cause === "object") {
    const c = mpData.cause;
    const desc = c.description || c.message || "";
    const code = c.code ? `[${c.code}]` : "";
    const causeStr = [code, desc].filter(Boolean).join(" ");
    if (causeStr) parts.push(causeStr);
  }

  // 2. Process details (newer Mercado Pago API schemas)
  if (Array.isArray(mpData.details) && mpData.details.length > 0) {
    const details = mpData.details.map((d: any) => {
      if (!d) return "";
      if (typeof d === "string") return d;
      const field = d.field ? `${d.field}: ` : "";
      const msg = d.message || d.description || JSON.stringify(d);
      return `${field}${msg}`;
    }).filter(Boolean);
    if (details.length > 0) {
      parts.push(details.join("; "));
    }
  }

  // 3. Process errors array
  if (Array.isArray(mpData.errors) && mpData.errors.length > 0) {
    const errs = mpData.errors.map((e: any) => {
      if (!e) return "";
      if (typeof e === "string") return e;
      return e.message || e.description || JSON.stringify(e);
    }).filter(Boolean);
    if (errs.length > 0) {
      parts.push(errs.join("; "));
    }
  }

  // 4. Message or error property
  const mainMsg = mpData.message || mpData.error_description || (typeof mpData.error === "string" ? mpData.error : "");
  if (mainMsg && !parts.some((p) => p.includes(mainMsg))) {
    parts.unshift(mainMsg);
  }

  if (parts.length > 0) {
    return parts.join(" - ");
  }

  try {
    const jsonStr = JSON.stringify(mpData);
    if (jsonStr !== "{}" && jsonStr.length < 300) {
      return jsonStr;
    }
  } catch {
    // ignore
  }

  return status ? `Erro HTTP ${status}` : "Erro desconhecido retornado pelo Mercado Pago";
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function extractIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
         req.headers.get("cf-connecting-ip") ||
         req.headers.get("x-real-ip") ||
         "unknown";
}

export function extractSessionIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64Payload = parts[1];
    const base64 = b64Payload.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);
    return parsed.session_id || parsed.sid || null;
  } catch {
    return null;
  }
}

export function parseUserAgent(userAgent: string): { browser: string; os: string; device_type: string } {
  const ua = userAgent || "";
  let browser = "Navegador Web";
  if (ua.includes("Edg/")) {
    browser = "Edge";
  } else if (ua.includes("Chrome/") && !ua.includes("Edg/")) {
    browser = "Google Chrome";
  } else if (ua.includes("Firefox/")) {
    browser = "Firefox";
  } else if (ua.includes("Safari/") && !ua.includes("Chrome/")) {
    browser = "Safari";
  } else if (ua.includes("Opera/") || ua.includes("OPR/")) {
    browser = "Opera";
  }

  let os = "Dispositivo";
  if (ua.includes("Windows")) {
    os = "Windows";
  } else if (ua.includes("Macintosh") || ua.includes("Mac OS")) {
    os = "macOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  } else if (ua.includes("Android")) {
    os = "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  }

  let device_type = "Desktop";
  if (ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone")) {
    device_type = "Mobile";
  } else if (ua.includes("iPad") || ua.includes("Tablet")) {
    device_type = "Tablet";
  }

  return { browser, os, device_type };
}

function validateCpf(rawCpf: string): boolean {
  const digits = rawCpf.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * (10 - i);
  }
  let rest = sum % 11;
  let digit1 = rest < 2 ? 0 : 11 - rest;
  if (digit1 !== parseInt(digits[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * (11 - i);
  }
  rest = sum % 11;
  let digit2 = rest < 2 ? 0 : 11 - rest;
  return digit2 === parseInt(digits[10], 10);
}

const LICENSE_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function getUtc3DayBoundsIso(referenceDate = new Date()): { startIso: string; nextDayStartIso: string } {
  const utc3Ms = referenceDate.getTime() - 3 * 60 * 60 * 1000;
  const utc3Date = new Date(utc3Ms);
  const y = utc3Date.getUTCFullYear();
  const m = utc3Date.getUTCMonth();
  const d = utc3Date.getUTCDate();
  const dayStart = new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
  const nextDayStart = new Date(Date.UTC(y, m, d + 1, 3, 0, 0, 0));
  return {
    startIso: dayStart.toISOString(),
    nextDayStartIso: nextDayStart.toISOString(),
  };
}

function getUtc3DayStartIso(): string {
  return getUtc3DayBoundsIso().startIso;
}

function generateTestKey(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const groups: string[] = [];
  let byteIndex = 0;
  for (let g = 0; g < 4; g++) {
    let grp = "";
    for (let c = 0; c < 4; c++) {
      grp += LICENSE_CHARSET[randomBytes[byteIndex++] % LICENSE_CHARSET.length];
    }
    groups.push(grp);
  }
  return `NEKO-${groups.join("-")}`;
}

async function calculateSha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(text.trim().toUpperCase()));
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeKeyMask(key: string): string {
  return `NEKO-****-****-****-${key.trim().toUpperCase().slice(-4)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");
    const mpAccessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("[reseller-api] Erro: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes.");
      return json({ ok: false, error_code: "INTERNAL_ERROR", message: "Erro de configuração no servidor." }, 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

    // 1. Validação de Autenticação (Supabase Auth User JWT)
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    // Identificação ESTRITA da identidade do revendedor:
    // JWT -> auth.uid() -> resellers.user_id -> reseller.id
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) {
      console.warn(`[reseller-api] Autenticação rejeitada para IP ${extractIp(req)}: token_present=${Boolean(token)}, auth_error=${authErr?.message || "user_not_found"}`);
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    // Consulta o revendedor EXCLUSIVAMENTE pelo user_id do usuário autenticado no auth.users
    const { data: reseller, error: resellerErr } = await supabaseAdmin
      .from("resellers")
      .select("id, name, email, phone, status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (resellerErr || !reseller) {
      return json({ ok: false, error_code: "FORBIDDEN", message: "Revendedor não encontrado ou acesso não autorizado." }, 403);
    }

    if (reseller.status !== "active") {
      return json({ ok: false, error_code: "RESELLER_INACTIVE", message: "Você não possui permissão para acessar esta área." }, 403);
    }

    // 2. Verificação de Revogação de Sessão Ativa
    const currentSessionId = extractSessionIdFromJwt(token);
    if (currentSessionId) {
      try {
        const { data: sessionRec, error: sessionErr } = await supabaseAdmin
          .from("reseller_sessions")
          .select("id, is_revoked")
          .eq("session_id", currentSessionId)
          .maybeSingle();

        if (!sessionErr && sessionRec && sessionRec.is_revoked) {
          console.warn(`[reseller-api] Sessão revogada detectada (${currentSessionId}) para revendedor ${reseller.id}. Rejeitando com 401.`);
          return json({
            ok: false,
            error_code: "SESSION_REVOKED",
            message: "Esta sessão foi desconectada em outro dispositivo. Faça login novamente.",
          }, 401);
        }
      } catch (err) {
        // Fallback resiliente caso a migration não tenha sido aplicada remotamente
        console.warn("[reseller-api] Falha silenciosa ao verificar reseller_sessions:", err);
      }
    }

  const url = new URL(req.url);
  let action = url.searchParams.get("action") || "";

  // ============================================================================
  // GET: CONSULTA DE DETALHES DE UMA VENDA OU PREÇOS
  // ============================================================================
  if (req.method === "GET") {
    // --------------------------------------------------------------------------
    // AÇÃO GET: ESTATÍSTICAS CONSOLIDADAS DO PAINEL DO REVENDEDOR (get_overview_stats)
    // --------------------------------------------------------------------------
    if (action === "get_overview_stats") {
      // 1. Total de vendas e lucro líquido real das vendas pagas/entregues
      const { data: sales, error: salesErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("id, status, profit_snapshot")
        .eq("reseller_id", reseller.id);

      if (salesErr) return json({ ok: false, message: salesErr.message }, 500);

      const totalSales = (sales || []).length;
      let resellerProfit = 0;
      if (sales) {
        for (const s of sales) {
          if (s.status === "paid" || s.status === "license_delivered") {
            resellerProfit += Number(s.profit_snapshot || 0);
          }
        }
      }

      // 2. Clientes Ativos e Inativos (Apenas licenças comerciais e vendas de clientes)
      // REGRA CRÍTICA: Licenças TEST NÃO entram nessas métricas!
      const nowMs = Date.now();
      const { data: commercialLicenses, error: licErr } = await supabaseAdmin
        .from("licenses")
        .select("id, status, expires_at, customer_email, license_type")
        .eq("reseller_id", reseller.id)
        .neq("license_type", "TEST");

      if (licErr) return json({ ok: false, message: licErr.message }, 500);

      const customerMap = new Map<string, { hasActiveLicense: boolean }>();
      if (commercialLicenses) {
        for (const lic of commercialLicenses) {
          const email = lic.customer_email?.trim().toLowerCase();
          if (!email) continue;
          const isActive = lic.status === "active" && (!lic.expires_at || new Date(lic.expires_at).getTime() > nowMs);
          const existing = customerMap.get(email);
          if (!existing) {
            customerMap.set(email, { hasActiveLicense: isActive });
          } else if (isActive) {
            existing.hasActiveLicense = true;
          }
        }
      }

      // Clientes adicionais que realizaram compras comerciais
      const { data: salesCustomers } = await supabaseAdmin
        .from("reseller_sales")
        .select("customer_email")
        .eq("reseller_id", reseller.id)
        .not("customer_email", "is", null);

      if (salesCustomers) {
        for (const sc of salesCustomers) {
          const email = sc.customer_email?.trim().toLowerCase();
          if (email && !customerMap.has(email)) {
            customerMap.set(email, { hasActiveLicense: false });
          }
        }
      }

      let activeCustomers = 0;
      let inactiveCustomers = 0;
      for (const c of customerMap.values()) {
        if (c.hasActiveLicense) {
          activeCustomers += 1;
        } else {
          inactiveCustomers += 1;
        }
      }

      // 3. Contagem de testes gerados hoje (UTC-3)
      const { startIso, nextDayStartIso } = getUtc3DayBoundsIso();
      const { count: todayTestsCount } = await supabaseAdmin
        .from("licenses")
        .select("id", { count: "exact", head: true })
        .eq("reseller_id", reseller.id)
        .eq("license_type", "TEST")
        .gte("created_at", startIso)
        .lt("created_at", nextDayStartIso);

      return json({
        ok: true,
        stats: {
          total_sales: totalSales,
          active_customers: activeCustomers,
          inactive_customers: inactiveCustomers,
          reseller_profit: Number(resellerProfit.toFixed(2)),
          today_tests_count: todayTestsCount || 0,
          daily_test_limit: 10,
        },
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: LISTAGEM DE LICENÇAS DE TESTE DO REVENDEDOR (list_test_licenses)
    // --------------------------------------------------------------------------
    if (action === "list_test_licenses") {
      const { startIso, nextDayStartIso } = getUtc3DayBoundsIso();
      const [licensesRes, countRes] = await Promise.all([
        supabaseAdmin
          .from("licenses")
          .select("id, customer_name, customer_email, created_at, expires_at, status")
          .eq("reseller_id", reseller.id)
          .eq("license_type", "TEST")
          .gte("created_at", startIso)
          .lt("created_at", nextDayStartIso)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("licenses")
          .select("id", { count: "exact", head: true })
          .eq("reseller_id", reseller.id)
          .eq("license_type", "TEST")
          .gte("created_at", startIso)
          .lt("created_at", nextDayStartIso),
      ]);

      if (licensesRes.error) {
        return json({ ok: false, message: licensesRes.error.message }, 500);
      }

      const nowMs = Date.now();
      const formattedLicenses = (licensesRes.data || []).map((lic: any) => {
        let effectiveStatus = lic.status;
        if (lic.status !== "revoked" && lic.expires_at) {
          const expMs = new Date(lic.expires_at).getTime();
          if (!Number.isNaN(expMs) && expMs <= nowMs) {
            effectiveStatus = "expired";
          }
        }
        return {
          ...lic,
          status: effectiveStatus,
        };
      });

      return json({
        ok: true,
        licenses: formattedLicenses,
        today_tests_count: countRes.count || 0,
        daily_limit: 10,
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: DETALHES DE UMA VENDA DO REVENDEDOR (get_sale)
    // --------------------------------------------------------------------------
    if (action === "get_sale") {
      const saleId = url.searchParams.get("sale_id");
      if (!saleId) return json({ ok: false, message: "sale_id obrigatório." }, 400);

      const { data: sale, error: saleErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("id", saleId)
        .eq("reseller_id", reseller.id)
        .maybeSingle();

      if (saleErr || !sale) return json({ ok: false, message: "Venda não encontrada ou não pertencente à sua conta de revendedor." }, 404);

      // Fallback de polling seguro: se a venda ainda está pendente mas tem mp_payment_id, consulta Orders API
      if (sale.status === "pending" && sale.mp_payment_id && mpAccessToken) {
        try {
          let orderData: any = null;
          const mpRes = await fetch(`https://api.mercadopago.com/v1/orders/${sale.mp_payment_id}`, {
            headers: {
              "Authorization": `Bearer ${mpAccessToken.trim()}`,
            },
          });
          if (mpRes.ok) {
            orderData = await mpRes.json();
          } else if (mpRes.status === 404 && sale.id) {
            // Se o ID armazenado gerou 404 (ex: ID de pagamento legado de checkout anterior), busca a order por external_reference
            try {
              const now = new Date();
              const beginDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
              const endDate = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
              const searchRes = await fetch(
                `https://api.mercadopago.com/v1/orders/search?begin_date=${encodeURIComponent(beginDate)}&end_date=${encodeURIComponent(endDate)}&external_reference=${encodeURIComponent(sale.id)}`,
                {
                  headers: { "Authorization": `Bearer ${mpAccessToken.trim()}` },
                }
              );
              if (searchRes.ok) {
                const searchData = await searchRes.json();
                const matchedOrder = searchData?.data?.[0] || searchData?.results?.[0];
                if (matchedOrder) {
                  orderData = matchedOrder;
                  sale.mp_payment_id = String(matchedOrder.id);
                  await supabaseAdmin
                    .from("reseller_sales")
                    .update({ mp_payment_id: sale.mp_payment_id, updated_at: new Date().toISOString() })
                    .eq("id", sale.id);
                }
              }
            } catch (searchErr) {
              console.warn("[reseller-api] Fallback search de order por external_reference falhou:", searchErr);
            }
          }

          if (orderData) {
            // Suporte completo a formato de transactions como array ou objeto
            const payments = Array.isArray(orderData?.transactions?.payments)
              ? orderData.transactions.payments
              : Array.isArray(orderData?.transactions)
              ? orderData.transactions.flatMap((t: any) => (Array.isArray(t?.payments) ? t.payments : t ? [t] : []))
              : Array.isArray(orderData?.payments)
              ? orderData.payments
              : [];

            const orderStatus = String(orderData?.status || "");
            const orderStatusDetail = String(orderData?.status_detail || "");

            const paymentTx = payments[0];
            const txStatus = String(paymentTx?.status || "");
            const txStatusDetail = String(paymentTx?.status_detail || "");

            const isOrderAccredited =
              (orderData?.status === "processed" && orderData?.status_detail === "accredited") ||
              ((orderStatus === "closed" || orderStatus === "approved") && (orderStatusDetail === "accredited" || orderStatusDetail === "approved"));

            const isTxAccredited =
              (txStatus === "processed" || txStatus === "approved") &&
              (txStatusDetail === "accredited" || txStatusDetail === "approved");

            const isPaymentAccredited = payments.some((p: any) =>
              (p?.status === "approved" || p?.status === "processed") &&
              (p?.status_detail === "accredited" || p?.status_detail === "approved")
            );

            const isApproved = isOrderAccredited || isTxAccredited || Boolean(isPaymentAccredited);

            const paidAmount = Number(
              paymentTx?.amount ??
              paymentTx?.transaction_amount ??
              paymentTx?.total_amount ??
              orderData?.total_amount ??
              orderData?.amount ??
              0
            );
            const expectedCost = Number(sale.neko_cost_snapshot);

            // Log seguro de diagnóstico do polling (sem tokens, sem secrets, sem CPF)
            console.log("[reseller-api] Diagnóstico de polling Order:", {
              saleId: sale.id,
              orderId: sale.mp_payment_id,
              orderStatus,
              orderStatusDetail,
              txStatus,
              txStatusDetail,
              isApproved,
              paidAmount,
              expectedCost,
            });

            if (isApproved && Math.abs(paidAmount - expectedCost) <= 0.01) {
              const nowIso = new Date().toISOString();
              sale.status = "paid";
              sale.paid_at = nowIso;
              await supabaseAdmin
                .from("reseller_sales")
                .update({
                  status: "paid",
                  paid_at: nowIso,
                  updated_at: nowIso,
                })
                .eq("id", sale.id);

              console.log(`[reseller-api] SUCESSO: Venda ${sale.id} confirmada como PAGA via Polling da Orders API (Order ID: ${sale.mp_payment_id}).`);
            } else if (!isApproved) {
              let newStatus = sale.status;
              if (orderStatus === "cancelled" || orderStatus === "canceled" || orderStatus === "rejected") {
                newStatus = "cancelled";
              } else if (orderStatus === "expired") {
                newStatus = "expired";
              }
              if (newStatus !== sale.status) {
                sale.status = newStatus;
                await supabaseAdmin
                  .from("reseller_sales")
                  .update({ status: newStatus, updated_at: new Date().toISOString() })
                  .eq("id", sale.id);
              }
            }
          }
        } catch (pollErr) {
          console.warn("[reseller-api] Fallback polling de order no Mercado Pago falhou silenciosamente:", pollErr);
        }
      }

      // Busca dados complementares da licença vinculada se houver
      let licenseKeyMask: string | null = null;
      let licenseStatus: string | null = null;
      if (sale.license_id) {
        const { data: licData } = await supabaseAdmin
          .from("licenses")
          .select("id, key_mask, status")
          .eq("id", sale.license_id)
          .eq("reseller_id", reseller.id)
          .maybeSingle();
        if (licData) {
          licenseKeyMask = licData.key_mask;
          licenseStatus = licData.status;
        }
      }

      // Auto-recuperação de PIX pendente caso tenha ficado nulo anteriormente
      if (sale.status === "pending" && !sale.pix_qr_code && sale.mp_payment_id && mpAccessToken) {
        try {
          const getOrderRes = await fetch(`https://api.mercadopago.com/v1/orders/${sale.mp_payment_id}`, {
            headers: { Authorization: `Bearer ${mpAccessToken.trim()}` },
          });
          if (getOrderRes.ok) {
            const orderData = await getOrderRes.json();
            const recovered = extractOrderPixData(orderData);
            if (recovered.pixQrCode) {
              sale.pix_qr_code = recovered.pixQrCode;
              sale.pix_qr_code_base64 = recovered.pixQrCodeBase64;
              sale.ticket_url = recovered.ticketUrl;
              await supabaseAdmin
                .from("reseller_sales")
                .update({
                  pix_qr_code: recovered.pixQrCode,
                  pix_qr_code_base64: recovered.pixQrCodeBase64,
                  ticket_url: recovered.ticketUrl,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", sale.id);
            }
          }
        } catch (e) {
          console.warn("[reseller-api] Erro ao auto-recuperar PIX durante get_sale:", e);
        }
      }

      const salePrice = Number(sale.resale_price_snapshot || 0);
      const nekoCost = Number(sale.neko_cost_snapshot || 0);
      const resellerProfit = Number(sale.profit_snapshot || 0);

      return json({
        ok: true,
        sale: {
          id: sale.id,
          reseller_id: sale.reseller_id,
          reseller_name: reseller.name,
          plan: sale.plan,
          sale_price: salePrice,
          neko_cost: nekoCost,
          reseller_profit: resellerProfit,
          neko_cost_snapshot: nekoCost,
          resale_price_snapshot: salePrice,
          profit_snapshot: resellerProfit,
          status: sale.status,
          customer_name: sale.customer_name || "Cliente",
          customer_email: sale.customer_email || "—",
          customer_whatsapp: sale.customer_whatsapp || null,
          mp_payment_id: sale.mp_payment_id || null,
          mp_external_reference: sale.mp_external_reference || null,
          license_id: sale.license_id || null,
          license_key_mask: licenseKeyMask,
          license_status: licenseStatus,
          pix_qr_code: sale.pix_qr_code || null,
          pix_qr_code_base64: sale.pix_qr_code_base64 || null,
          ticket_url: sale.ticket_url || null,
          expires_at: sale.expires_at || null,
          paid_at: sale.paid_at || null,
          created_at: sale.created_at,
          updated_at: sale.updated_at,
        },
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: LISTAGEM DE VENDAS DO REVENDEDOR COM FILTROS, MÉTRICAS E PAGINAÇÃO
    // --------------------------------------------------------------------------
    if (action === "list_sales") {
      const search = url.searchParams.get("search")?.trim().toLowerCase() || "";
      const rawPlan = url.searchParams.get("plan")?.trim().toUpperCase();
      const planFilter = (!rawPlan || rawPlan === "ALL") ? null : rawPlan;

      const rawStatus = url.searchParams.get("status")?.trim().toLowerCase();
      const statusFilter = (!rawStatus || rawStatus === "all") ? null : rawStatus;

      const dateFrom = url.searchParams.get("date_from")?.trim() || "";
      const dateTo = url.searchParams.get("date_to")?.trim() || "";
      const pageStr = url.searchParams.get("page");
      const limitStr = url.searchParams.get("limit");

      const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
      const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

      // 1. Busca todas as vendas pertencentes estritamente a este revendedor autenticado
      const { data: allSales, error: salesErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("reseller_id", reseller.id)
        .order("created_at", { ascending: false });

      if (salesErr) return json({ ok: false, message: salesErr.message }, 500);

      const rawSales = allSales || [];

      // 2. Coleta IDs de licenças para enriquecimento com máscara de chave
      const licenseIds = rawSales
        .map((s: any) => s.license_id)
        .filter((id: string | null): id is string => !!id);

      const licenseMap = new Map<string, { key_mask: string; status: string }>();
      if (licenseIds.length > 0) {
        const { data: lics } = await supabaseAdmin
          .from("licenses")
          .select("id, key_mask, status")
          .in("id", licenseIds)
          .eq("reseller_id", reseller.id);
        if (lics) {
          for (const l of lics) {
            licenseMap.set(l.id, { key_mask: l.key_mask, status: l.status });
          }
        }
      }

      // 3. Formatação unificada das vendas do revendedor
      const mappedSales = rawSales.map((s: any) => {
        const resalePrice = Number(s.resale_price_snapshot || 0);
        const nekoCost = Number(s.neko_cost_snapshot || 0);
        const profit = Number(s.profit_snapshot || 0);
        const lic = s.license_id ? licenseMap.get(s.license_id) : null;

        return {
          id: s.id,
          reseller_id: s.reseller_id,
          reseller_name: reseller.name,
          plan: s.plan,
          sale_price: resalePrice,
          neko_cost: nekoCost,
          reseller_profit: profit,
          status: s.status,
          customer_name: s.customer_name || "Cliente",
          customer_email: s.customer_email || "—",
          customer_whatsapp: s.customer_whatsapp || null,
          mp_payment_id: s.mp_payment_id || null,
          mp_external_reference: s.mp_external_reference || null,
          license_id: s.license_id || null,
          license_key_mask: lic ? lic.key_mask : null,
          license_status: lic ? lic.status : null,
          pix_qr_code: s.pix_qr_code || null,
          expires_at: s.expires_at || null,
          paid_at: s.paid_at || null,
          created_at: s.created_at,
          updated_at: s.updated_at,
        };
      });

      // 4. Cálculo das métricas consolidadas DO REVENDEDOR (sempre sobre a totalidade de vendas dele)
      const totalSales = mappedSales.length;
      let completedSales = 0;
      let totalRevenue = 0;
      let resellerProfit = 0;

      mappedSales.forEach((s: any) => {
        const isCompleted = s.status === "paid" || s.status === "license_delivered";
        if (isCompleted) {
          completedSales += 1;
          totalRevenue += s.sale_price;
          resellerProfit += s.reseller_profit;
        }
      });

      // 5. Aplicar filtros em memória
      let filtered = mappedSales;

      if (search) {
        filtered = filtered.filter((s: any) => {
          const name = (s.customer_name || "").toLowerCase();
          const email = (s.customer_email || "").toLowerCase();
          const whatsapp = (s.customer_whatsapp || "").toLowerCase();
          const mpId = (s.mp_payment_id || "").toLowerCase();
          const ref = (s.mp_external_reference || "").toLowerCase();
          const keyMask = (s.license_key_mask || "").toLowerCase();
          return (
            name.includes(search) ||
            email.includes(search) ||
            whatsapp.includes(search) ||
            mpId.includes(search) ||
            ref.includes(search) ||
            keyMask.includes(search)
          );
        });
      }

      if (planFilter) {
        filtered = filtered.filter((s: any) => s.plan?.toUpperCase() === planFilter);
      }

      if (statusFilter) {
        filtered = filtered.filter((s: any) => s.status?.toLowerCase() === statusFilter);
      }

      if (dateFrom) {
        const fromTime = new Date(dateFrom).getTime();
        filtered = filtered.filter((s: any) => new Date(s.created_at).getTime() >= fromTime);
      }

      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        const toTime = toDate.getTime();
        filtered = filtered.filter((s: any) => new Date(s.created_at).getTime() <= toTime);
      }

      // 6. Paginação dos resultados filtrados
      const totalFiltered = filtered.length;
      const totalPages = Math.ceil(totalFiltered / limit) || 1;
      const offset = (page - 1) * limit;
      const paginatedSales = filtered.slice(offset, offset + limit);

      return json({
        ok: true,
        sales: paginatedSales,
        stats: {
          total_sales: totalSales,
          completed_sales: completedSales,
          total_revenue: totalRevenue,
          reseller_profit: resellerProfit,
        },
        pagination: {
          page,
          limit,
          total_items: totalFiltered,
          total_pages: totalPages,
        },
      });
    }

    if (action === "get_price_settings") {
      const { data: settings } = await supabaseAdmin
        .from("reseller_price_settings")
        .select("plan, neko_cost, resale_price")
        .eq("reseller_id", reseller.id);

      const existingMap: Record<string, number> = {};
      if (settings) {
        for (const s of settings) {
          existingMap[s.plan] = Number(s.resale_price);
        }
      }

      const officialPricing = await getOfficialPricing(supabaseAdmin);
      const result = (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map((plan) => {
        const nekoCost = officialPricing[plan].neko_cost;
        const resalePrice = existingMap[plan] ?? officialPricing[plan].suggested_resale_price;
        return {
          plan,
          neko_cost: nekoCost,
          resale_price: resalePrice,
          profit: Number((resalePrice - nekoCost).toFixed(2)),
        };
      });

      return json({ ok: true, settings: result });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: LISTAGEM DE LICENÇAS DO REVENDEDOR COM FILTROS E MÉTRICAS
    // --------------------------------------------------------------------------
    if (action === "list_licenses") {
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
      const planParam = url.searchParams.get("plan")?.trim().toUpperCase();
      const pageStr = url.searchParams.get("page");
      const limitStr = url.searchParams.get("limit");

      const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
      const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

      // 1. Busca todas as licenças do revendedor autenticado (estritamente comerciais, sem TEST)
      const { data: allResellerLicenses, error: allErr } = await supabaseAdmin
        .from("licenses")
        .select("id, key_mask, plan, status, max_devices, expires_at, entitlements, customer_name, customer_email, customer_whatsapp, created_at, updated_at, license_type")
        .eq("reseller_id", reseller.id)
        .neq("license_type", "TEST")
        .order("created_at", { ascending: false });

      if (allErr) {
        return json({ ok: false, message: allErr.message }, 500);
      }

      // Garante exclusão estrita de licenças TEST em memória também
      const allList = (allResellerLicenses || []).filter((l: any) => l.license_type !== "TEST");
      const nowMs = Date.now();

      // Métricas reais isoladas do revendedor (apenas comerciais)
      const totalLicenses = allList.length;
      const activeLicenses = allList.filter((l: any) => {
        if (l.status !== "active") return false;
        if (l.expires_at && new Date(l.expires_at).getTime() <= nowMs) return false;
        return true;
      }).length;
      const expiredLicenses = allList.filter((l: any) => {
        if (l.status === "expired") return true;
        if (l.expires_at && new Date(l.expires_at).getTime() <= nowMs) return true;
        return false;
      }).length;
      const testLicenses = 0; // Regra 18: TEST nunca entra em Revendedor -> Licenças

      // 2. Aplicação de Filtros
      let filtered = allList;

      if (search) {
        filtered = filtered.filter((l: any) => {
          const n = (l.customer_name || "").toLowerCase();
          const e = (l.customer_email || "").toLowerCase();
          const w = (l.customer_whatsapp || "").toLowerCase();
          const k = (l.key_mask || "").toLowerCase();
          return n.includes(search) || e.includes(search) || w.includes(search) || k.includes(search);
        });
      }

      if (statusParam && statusParam !== "all") {
        if (statusParam === "active") {
          filtered = filtered.filter((l: any) => {
            return l.status === "active" && (!l.expires_at || new Date(l.expires_at).getTime() > nowMs);
          });
        } else if (statusParam === "expired") {
          filtered = filtered.filter((l: any) => {
            return l.status === "expired" || (l.expires_at && new Date(l.expires_at).getTime() <= nowMs);
          });
        } else if (statusParam === "test") {
          filtered = filtered.filter((l: any) => l.license_type === "TEST");
        } else {
          filtered = filtered.filter((l: any) => l.status === statusParam);
        }
      }

      if (planParam && planParam !== "ALL") {
        filtered = filtered.filter((l: any) => {
          const p = (l.plan || "").toUpperCase();
          if (planParam === "TEST") return l.license_type === "TEST" || p === "TEST";
          return p === planParam;
        });
      }

      // Paginação
      const totalFiltered = filtered.length;
      const totalPages = Math.ceil(totalFiltered / limit) || 1;
      const offset = (page - 1) * limit;
      const paginatedLicenses = filtered.slice(offset, offset + limit);

      // Busca dispositivos ativos para os itens paginados
      const paginatedIds = paginatedLicenses.map((l: any) => l.id);
      const activationsMap = new Map<string, Array<{ device_id: string; device_name: string; last_validated_at: string }>>();

      if (paginatedIds.length > 0) {
        const { data: actData } = await supabaseAdmin
          .from("license_activations")
          .select("license_id, device_id, device_name, last_validated_at")
          .in("license_id", paginatedIds)
          .order("created_at", { ascending: true });

        if (actData) {
          for (const act of actData) {
            const list = activationsMap.get(act.license_id) || [];
            list.push({
              device_id: act.device_id,
              device_name: act.device_name,
              last_validated_at: act.last_validated_at,
            });
            activationsMap.set(act.license_id, list);
          }
        }
      }

      const formatted = paginatedLicenses.map((lic: any) => ({
        id: lic.id,
        key_mask: lic.key_mask,
        plan: lic.plan,
        status: lic.status,
        max_devices: lic.max_devices || 1,
        expires_at: lic.expires_at,
        entitlements: lic.entitlements,
        customer_name: lic.customer_name || null,
        customer_email: lic.customer_email || null,
        customer_whatsapp: lic.customer_whatsapp || null,
        license_type: lic.license_type || "NORMAL",
        created_at: lic.created_at,
        updated_at: lic.updated_at,
        active_devices: activationsMap.get(lic.id) || [],
      }));

      return json({
        ok: true,
        licenses: formatted,
        stats: {
          total_licenses: totalLicenses,
          active_licenses: activeLicenses,
          expired_licenses: expiredLicenses,
          test_licenses: testLicenses,
        },
        pagination: {
          page,
          limit,
          total_items: totalFiltered,
          total_pages: totalPages,
        },
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: DETALHES DE UMA LICENÇA ESPECÍFICA DO REVENDEDOR
    // --------------------------------------------------------------------------
    if (action === "get_license_details") {
      const licenseId = url.searchParams.get("license_id")?.trim();
      if (!licenseId) {
        return json({ ok: false, message: "license_id ausente." }, 400);
      }

      const { data: lic, error: licErr } = await supabaseAdmin
        .from("licenses")
        .select("id, key_mask, plan, status, max_devices, expires_at, entitlements, customer_name, customer_email, customer_whatsapp, created_at, updated_at, license_type, reseller_id")
        .eq("id", licenseId)
        .eq("reseller_id", reseller.id)
        .maybeSingle();

      if (licErr) {
        return json({ ok: false, message: licErr.message }, 500);
      }

      if (!lic) {
        return json({ ok: false, message: "Licença não encontrada ou não pertencente à sua conta de revendedor." }, 404);
      }

      const { data: activations } = await supabaseAdmin
        .from("license_activations")
        .select("device_id, device_name, last_validated_at")
        .eq("license_id", lic.id)
        .order("created_at", { ascending: true });

      const { data: sale } = await supabaseAdmin
        .from("reseller_sales")
        .select("id, plan, neko_cost_snapshot, resale_price_snapshot, profit_snapshot, status, paid_at, created_at")
        .eq("license_id", lic.id)
        .eq("reseller_id", reseller.id)
        .maybeSingle();

      return json({
        ok: true,
        license: {
          id: lic.id,
          key_mask: lic.key_mask,
          plan: lic.plan,
          status: lic.status,
          max_devices: lic.max_devices || 1,
          expires_at: lic.expires_at,
          entitlements: lic.entitlements,
          customer_name: lic.customer_name || null,
          customer_email: lic.customer_email || null,
          customer_whatsapp: lic.customer_whatsapp || null,
          license_type: lic.license_type || "NORMAL",
          created_at: lic.created_at,
          updated_at: lic.updated_at,
          active_devices: activations || [],
          sale: sale ? {
            id: sale.id,
            plan: sale.plan,
            amount: Number(sale.resale_price_snapshot || 0),
            profit: Number(sale.profit_snapshot || 0),
            status: sale.status,
            created_at: sale.paid_at || sale.created_at,
          } : null,
        },
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO GET: LISTAGEM DE SESSÕES/DISPOSITIVOS ATIVOS DO REVENDEDOR (list_sessions)
    // --------------------------------------------------------------------------
    if (action === "list_sessions") {
      try {
        const { data: dbSessions, error: listErr } = await supabaseAdmin
          .from("reseller_sessions")
          .select("id, session_id, device_name, browser, operating_system, ip_address, approximate_location, is_revoked, created_at, last_active_at")
          .eq("reseller_id", reseller.id)
          .eq("is_revoked", false)
          .order("last_active_at", { ascending: false });

        if (listErr) {
          console.warn("[reseller-api] Erro ao listar reseller_sessions:", listErr);
          return json({ ok: true, sessions: [] });
        }

        const sessions = (dbSessions || []).map((s: any) => ({
          id: s.id,
          session_id: s.session_id,
          device_name: s.device_name,
          browser: s.browser,
          operating_system: s.operating_system,
          ip_address: s.ip_address || null,
          approximate_location: s.approximate_location || null,
          is_current: currentSessionId ? String(s.session_id).toLowerCase() === String(currentSessionId).toLowerCase() : false,
          created_at: s.created_at,
          last_active_at: s.last_active_at,
        }));

        return json({ ok: true, sessions });
      } catch (err: any) {
        console.warn("[reseller-api] Exceção em list_sessions (fallback resiliente):", err);
        return json({ ok: true, sessions: [] });
      }
    }

    return json({ ok: false, message: "Ação GET não suportada." }, 400);
  }

  // ============================================================================
  // POST: OPERAÇÕES COMERCIAIS, PREÇOS E GESTÃO DO REVENDEDOR
  // ============================================================================
  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, message: "JSON inválido." }, 400);
    }

    if (body.action && typeof body.action === "string") {
      action = body.action;
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: GERAÇÃO DE LICENÇA DE TESTE GRÁTIS (create_test_license)
    // --------------------------------------------------------------------------
    if (action === "create_test_license") {
      const { customer_name, customer_email } = body;

      // 1. Validação estrita de Nome
      const cleanName = typeof customer_name === "string" ? customer_name.trim() : "";
      if (!cleanName || cleanName.length < 2) {
        return json({
          ok: false,
          error_code: "INVALID_NAME",
          message: "Nome do cliente é obrigatório.",
        }, 400);
      }

      // 2. Validação estrita de E-mail
      const cleanEmail = typeof customer_email === "string" ? customer_email.trim().toLowerCase() : "";
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 255) {
        return json({
          ok: false,
          error_code: "INVALID_EMAIL",
          message: "E-mail do cliente é obrigatório e deve ser válido.",
        }, 400);
      }

      // 3. Validação de Quota Diária no Backend (10 licenças/dia UTC-3)
      const { startIso, nextDayStartIso } = getUtc3DayBoundsIso();
      const { count: todayTestsCount, error: countErr } = await supabaseAdmin
        .from("licenses")
        .select("id", { count: "exact", head: true })
        .eq("reseller_id", reseller.id)
        .eq("license_type", "TEST")
        .gte("created_at", startIso)
        .lt("created_at", nextDayStartIso);

      if (countErr) {
        return json({ ok: false, message: countErr.message }, 500);
      }

      if ((todayTestsCount || 0) >= 10) {
        return json({
          ok: false,
          error_code: "QUOTA_EXCEEDED",
          message: "Você atingiu o limite de 10 licenças de teste por dia.",
        }, 400);
      }

      // 4. Geração Criptográfica e Encriptação Segura da Chave
      const plainKey = generateTestKey();
      const key_hash = await calculateSha256Hex(plainKey);
      const key_mask = makeKeyMask(plainKey);
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6 horas

      let encryptedKey: string | null = null;
      if (adminSecret) {
        try {
          encryptedKey = await encryptLicenseKey(plainKey, adminSecret);
        } catch (encErr) {
          console.warn("[reseller-api] Falha ao criptografar chave de teste:", encErr);
        }
      }

      // 5. Inserção na Tabela licenses vinculando ao revendedor
      const defaultEntitlements = [
        "agent_execution",
        "preview_server",
        "file_manipulation",
        "cloud_supabase",
        "cloud_github",
        "cloud_vercel",
      ];

      const { data: newLic, error: insertError } = await supabaseAdmin
        .from("licenses")
        .insert({
          user_id: null,
          key_hash,
          key_mask,
          plan: "MONTHLY",
          license_type: "TEST",
          status: "active",
          max_devices: 1,
          customer_name: cleanName.slice(0, 128),
          customer_email: cleanEmail.slice(0, 255),
          expires_at: expiresAt,
          entitlements: defaultEntitlements,
          encrypted_key: encryptedKey,
          reseller_id: reseller.id,
        })
        .select("id, customer_name, customer_email, expires_at, created_at, status")
        .single();

      if (insertError || !newLic) {
        return json({ ok: false, message: insertError?.message || "Erro ao registrar licença de teste." }, 500);
      }

      // 6. Auditoria de eventos
      await supabaseAdmin.from("license_events").insert({
        license_id: newLic.id,
        device_id: "00000000000000000000000000000000",
        event_type: "generate",
        ip_address: extractIp(req),
        metadata: {
          action: "reseller_create_test_license",
          reseller_id: reseller.id,
          customer_email: cleanEmail,
        },
      });

      // 7. Envio da Chave EXCLUSIVAMENTE para o E-mail do Cliente
      try {
        await emailClient.sendLicenseDelivery({
          customerName: cleanName,
          customerEmail: cleanEmail,
          licenseKey: plainKey, // Enviada SOMENTE ao cliente por e-mail!
          plan: "MONTHLY",
          maxDevices: 1,
          license_type: "TEST",
          test_duration_label: "6 horas",
          test_expires_at: expiresAt,
        });
      } catch (emailErr) {
        console.warn("[reseller-api] Aviso ao despachar e-mail de licença de teste:", emailErr);
      }

      // 8. Resposta Segura: A CHAVE JAMAIS É RETORNADA AO REVENDEDOR
      return json({
        ok: true,
        message: "Licença de teste gerada com sucesso e enviada ao cliente.",
        license: {
          id: newLic.id,
          customer_name: newLic.customer_name,
          customer_email: newLic.customer_email,
          expires_at: newLic.expires_at,
          created_at: newLic.created_at,
          status: newLic.status,
        },
        today_count: (todayTestsCount || 0) + 1,
        daily_limit: 10,
      });
    }

    if (action === "create_checkout") {
      const { plan, customer_name, customer_email, customer_whatsapp, customer_cpf } = body;

      if (!plan || !["MONTHLY", "QUARTERLY", "ANNUAL"].includes(plan)) {
        return json({ ok: false, error_code: "INVALID_PLAN", message: "Plano inválido. Selecione MONTHLY, QUARTERLY ou ANNUAL." }, 400);
      }

      // 0. Tratamento e Reutilização do CPF do Revendedor na Compra
      let activeCpf = (user?.user_metadata?.cpf as string) || null;
      if (!activeCpf && typeof customer_cpf === "string" && customer_cpf.trim() !== "") {
        const cleanDigits = customer_cpf.replace(/\D/g, "");
        if (!validateCpf(cleanDigits)) {
          return json({ ok: false, error_code: "INVALID_CPF", message: "CPF inválido para faturamento da compra." }, 400);
        }
        activeCpf = cleanDigits;
        // Salva automaticamente o novo CPF no cadastro do revendedor para compras futuras
        if (user) {
          await supabaseAdmin.auth.admin.updateUserById(user.id, {
            user_metadata: {
              ...user.user_metadata,
              cpf: activeCpf,
            },
          }).catch((err) => {
            console.warn("[reseller-api] Aviso ao persistir CPF informado na compra:", err);
          });
        }
      }

      // 1. Custo Oficial NekoAI (Decidido dinamicamente no Servidor a partir de admin_settings)
      const officialPricing = await getOfficialPricing(supabaseAdmin);
      const officialNekoCost = officialPricing[plan as keyof typeof officialPricing]?.neko_cost ?? OFFICIAL_NEKO_COSTS[plan];

      // 2. Busca Preço de Revenda Configurado
      const { data: priceSetting } = await supabaseAdmin
        .from("reseller_price_settings")
        .select("resale_price")
        .eq("reseller_id", reseller.id)
        .eq("plan", plan)
        .single();

      const configuredResalePrice = priceSetting?.resale_price || officialNekoCost;

      // 3. Validação e Cálculo de Lucro no Backend (Ignora qualquer valor do frontend)
      if (configuredResalePrice < officialNekoCost) {
        return json({ ok: false, error_code: "INVALID_PRICE", message: "Preço de revenda configurado é menor que o custo NekoAI." }, 400);
      }
      const calculatedProfit = Number((configuredResalePrice - officialNekoCost).toFixed(2));

      // 4. Verificação de Idempotência / Cobrança Pendente Ativa
      const { data: existingPendingSale } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("reseller_id", reseller.id)
        .eq("plan", plan)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingPendingSale) {
        if (existingPendingSale.pix_qr_code) {
          console.log(`[reseller-api] Reutilizando cobrança PIX pendente ativa (sale_id: ${existingPendingSale.id})`);
          return json({
            ok: true,
            reused: true,
            sale_id: existingPendingSale.id,
            plan: existingPendingSale.plan,
            neko_cost: existingPendingSale.neko_cost_snapshot,
            resale_price: existingPendingSale.resale_price_snapshot,
            profit: existingPendingSale.profit_snapshot,
            neko_cost_snapshot: existingPendingSale.neko_cost_snapshot,
            resale_price_snapshot: existingPendingSale.resale_price_snapshot,
            profit_snapshot: existingPendingSale.profit_snapshot,
            pix_qr_code: existingPendingSale.pix_qr_code,
            pix_qr_code_base64: existingPendingSale.pix_qr_code_base64,
            expires_at: existingPendingSale.expires_at,
            message: "Cobrança PIX pendente localizada. Exibindo QR Code existente.",
          });
        }

        // Se a venda pendente possui mp_payment_id mas faltou o código PIX anteriormente, recupera na Orders API
        if (existingPendingSale.mp_payment_id && mpAccessToken) {
          try {
            const getOrderRes = await fetch(`https://api.mercadopago.com/v1/orders/${existingPendingSale.mp_payment_id}`, {
              headers: { Authorization: `Bearer ${mpAccessToken.trim()}` },
            });
            if (getOrderRes.ok) {
              const orderData = await getOrderRes.json();
              const recovered = extractOrderPixData(orderData);
              if (recovered.pixQrCode) {
                await supabaseAdmin
                  .from("reseller_sales")
                  .update({
                    pix_qr_code: recovered.pixQrCode,
                    pix_qr_code_base64: recovered.pixQrCodeBase64,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", existingPendingSale.id);

                return json({
                  ok: true,
                  reused: true,
                  sale_id: existingPendingSale.id,
                  plan: existingPendingSale.plan,
                  neko_cost: existingPendingSale.neko_cost_snapshot,
                  resale_price: existingPendingSale.resale_price_snapshot,
                  profit: existingPendingSale.profit_snapshot,
                  neko_cost_snapshot: existingPendingSale.neko_cost_snapshot,
                  resale_price_snapshot: existingPendingSale.resale_price_snapshot,
                  profit_snapshot: existingPendingSale.profit_snapshot,
                  pix_qr_code: recovered.pixQrCode,
                  pix_qr_code_base64: recovered.pixQrCodeBase64,
                  ticket_url: recovered.ticketUrl,
                  expires_at: existingPendingSale.expires_at,
                  message: "Cobrança PIX pendente recuperada com sucesso.",
                });
              }
            }
          } catch (recErr) {
            console.warn("[reseller-api] Erro ao recuperar PIX de order pendente existente:", recErr);
          }
        }
      }

      // 5. Criação da Venda com Snapshots Financeiros Congelados
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutos de validade PIX
      const externalReference = crypto.randomUUID();

      const { data: newSale, error: insertErr } = await supabaseAdmin
        .from("reseller_sales")
        .insert({
          reseller_id: reseller.id,
          plan,
          neko_cost_snapshot: officialNekoCost,
          resale_price_snapshot: configuredResalePrice,
          profit_snapshot: calculatedProfit,
          status: "pending",
          mp_external_reference: externalReference,
          customer_name: typeof customer_name === "string" ? customer_name.trim().slice(0, 128) : null,
          customer_email: typeof customer_email === "string" ? customer_email.trim().slice(0, 255) : null,
          customer_whatsapp: typeof customer_whatsapp === "string" ? customer_whatsapp.trim().slice(0, 32) : null,
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (insertErr || !newSale) {
        console.error("[reseller-api] Erro ao criar venda em reseller_sales:", insertErr);
        return json({ ok: false, error_code: "DB_ERROR", message: "Não foi possível registrar a intenção de compra." }, 500);
      }

      // 6. Comunicação com a API do Mercado Pago (Criação de Order PIX Nativo via Orders API)
      let mpPaymentId: string | null = null;
      let pixQrCode: string | null = null;
      let pixQrCodeBase64: string | null = null;
      let ticketUrl: string | null = null;

      if (mpAccessToken) {
        try {
          const nameParts = (reseller.name || "").trim().split(/\s+/);
          const firstName = nameParts[0] || "Revendedor";
          const lastName = nameParts.slice(1).join(" ") || undefined;
          const cleanCpfDigits = activeCpf ? activeCpf.replace(/\D/g, "") : null;
          const formattedAmount = officialNekoCost.toFixed(2);

          const orderPayload = {
            type: "online",
            total_amount: formattedAmount, // O PIX é estritamente no valor do custo NekoAI (neko_cost_snapshot)
            external_reference: newSale.id,
            processing_mode: "automatic",
            transactions: {
              payments: [
                {
                  amount: formattedAmount,
                  payment_method: {
                    id: "pix",
                    type: "bank_transfer",
                  },
                },
              ],
            },
            payer: {
              email: reseller.email,
              first_name: firstName,
              ...(lastName ? { last_name: lastName } : {}),
              ...(cleanCpfDigits && cleanCpfDigits.length === 11 ? { identification: { type: "CPF", number: cleanCpfDigits } } : {}),
            },
          };

          const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${mpAccessToken.trim()}`,
              "X-Idempotency-Key": newSale.id,
            },
            body: JSON.stringify(orderPayload),
          });

          const rawText = await mpResponse.text();
          let mpData: any = null;
          try {
            mpData = rawText ? JSON.parse(rawText) : null;
          } catch {
            mpData = rawText;
          }

          if (mpResponse.ok && mpData) {
            const extracted = extractOrderPixData(typeof mpData === "object" ? mpData : null);
            const orderId = String(mpData.id || extracted.orderId || "");
            mpPaymentId = orderId || extracted.paymentId || "";
            pixQrCode = extracted.pixQrCode;
            pixQrCodeBase64 = extracted.pixQrCodeBase64;
            ticketUrl = extracted.ticketUrl;

            if (!pixQrCode) {
              console.error("[reseller-api] Resposta da Orders API não continha código PIX válido para a Order:", mpData.id);
              return json({
                ok: false,
                error_code: "PIX_DATA_UNAVAILABLE",
                message: "O pedido foi criado no Mercado Pago, mas o código PIX não pôde ser gerado. Tente novamente.",
              }, 502);
            }
          } else {
            const detailedError = extractMercadoPagoErrorDetails(mpData, mpResponse.status);
            const sanitizedDiagnostics = sanitizeForDiagnostics(mpData);
            console.error("[reseller-api] Falha na criação de Order no Mercado Pago:", {
              status: mpResponse.status,
              details: detailedError,
              diagnostics: sanitizedDiagnostics,
            });
            return json({
              ok: false,
              error_code: "MP_ORDER_ERROR",
              message: `Erro ao gerar cobrança no Mercado Pago: ${detailedError}`,
              mp_status: mpResponse.status,
              mp_diagnostics: sanitizedDiagnostics,
            }, 400);
          }
        } catch (mpErr: any) {
          const errDetail = mpErr?.message || String(mpErr);
          console.error("[reseller-api] Exceção na chamada de API Mercado Pago Orders:", errDetail);
          return json({
            ok: false,
            error_code: "MP_CONNECTION_ERROR",
            message: `Erro de comunicação com o Mercado Pago: ${errDetail}`,
          }, 502);
        }
      } else {
        console.warn("[reseller-api] MERCADOPAGO_ACCESS_TOKEN não configurado nas variáveis de ambiente. Simulação local ativada.");
        // Em ambiente dev sem token MP, gera simulação de PIX para testes unitários / integração
        mpPaymentId = `sim_order_${Date.now()}`;
        pixQrCode = `00020126580014br.gov.bcb.pix0136simulado-nekoai-${newSale.id}5204000053039865405${officialNekoCost}5802BR5906NEKOAI6009SAO_PAULO62070503***6304ABCD`;
        pixQrCodeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      }

      // 7. Atualiza os dados de PIX e Mercado Pago no registro de venda
      await supabaseAdmin
        .from("reseller_sales")
        .update({
          mp_payment_id: mpPaymentId,
          pix_qr_code: pixQrCode,
          pix_qr_code_base64: pixQrCodeBase64,
          updated_at: new Date().toISOString(),
        })
        .eq("id", newSale.id);

      return json({
        ok: true,
        sale_id: newSale.id,
        plan: newSale.plan,
        neko_cost: officialNekoCost,
        resale_price: configuredResalePrice,
        profit: calculatedProfit,
        neko_cost_snapshot: officialNekoCost,
        resale_price_snapshot: configuredResalePrice,
        profit_snapshot: calculatedProfit,
        mp_payment_id: mpPaymentId,
        pix_qr_code: pixQrCode,
        pix_qr_code_base64: pixQrCodeBase64,
        ticket_url: ticketUrl,
        expires_at: expiresAt,
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: EMITIR E ENTREGAR LICENÇA COMERCIAL APÓS PAGAMENTO PIX
    // --------------------------------------------------------------------------
    if (action === "fulfill_sale") {
      const { sale_id, customer_name, customer_email, customer_whatsapp } = body;

      if (!sale_id) {
        return json({ ok: false, message: "sale_id obrigatório." }, 400);
      }

      // 1. Busca a venda e valida que pertence estritamente ao revendedor autenticado
      const { data: sale, error: saleErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("id", sale_id)
        .eq("reseller_id", reseller.id)
        .maybeSingle();

      if (saleErr || !sale) {
        return json({ ok: false, message: "Venda não encontrada ou não pertencente à sua conta de revendedor." }, 404);
      }

      // 2. Idempotência: se a licença já foi emitida, retorna os dados existentes sem duplicar
      if (sale.status === "license_delivered" && sale.license_id) {
        const { data: existingLic } = await supabaseAdmin
          .from("licenses")
          .select("id, key_mask, plan, status, expires_at")
          .eq("id", sale.license_id)
          .maybeSingle();

        return json({
          ok: true,
          already_fulfilled: true,
          message: "Licença já foi emitida e enviada para esta venda.",
          sale_id: sale.id,
          license_id: sale.license_id,
          key_mask: existingLic?.key_mask || null,
          plan: sale.plan,
          customer_email: sale.customer_email,
        });
      }

      // 3. Validação de status de pagamento: apenas vendas pagas podem emitir licença
      if (sale.status !== "paid" && sale.status !== "awaiting_customer") {
        return json({
          ok: false,
          error_code: "PAYMENT_NOT_CONFIRMED",
          message: "A licença só pode ser emitida após a confirmação do pagamento do custo NekoAI.",
        }, 400);
      }

      // 4. Validação dos dados do cliente final
      const finalCustomerName = (customer_name || sale.customer_name || "").trim();
      const finalCustomerEmail = (customer_email || sale.customer_email || "").trim().toLowerCase();
      const finalCustomerWhatsapp = (customer_whatsapp || sale.customer_whatsapp || null)?.trim() || null;

      if (!finalCustomerName || finalCustomerName.length < 2) {
        return json({
          ok: false,
          error_code: "INVALID_CUSTOMER_NAME",
          message: "Nome do cliente é obrigatório para emissão da licença.",
        }, 400);
      }

      if (!finalCustomerEmail || !finalCustomerEmail.includes("@")) {
        return json({
          ok: false,
          error_code: "INVALID_CUSTOMER_EMAIL",
          message: "E-mail do cliente inválido.",
        }, 400);
      }

      // 5. Cálculo rigoroso de duração por plano (MONTHLY=30d, QUARTERLY=90d, ANNUAL=365d)
      let days = 30;
      if (sale.plan === "QUARTERLY") {
        days = 90;
      } else if (sale.plan === "ANNUAL") {
        days = 365;
      }
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

      // 6. Geração criptográfica segura da chave (formato NEKO-XXXX-XXXX-XXXX-XXXX)
      const plainKey = generateTestKey();
      const key_hash = await calculateSha256Hex(plainKey);
      const key_mask = makeKeyMask(plainKey);

      let encryptedKey: string | null = null;
      if (adminSecret) {
        try {
          encryptedKey = await encryptLicenseKey(plainKey, adminSecret);
        } catch (encErr) {
          console.warn("[reseller-api] Falha ao criptografar chave comercial:", encErr);
        }
      }

      // 7. Inserção na tabela licenses (NORMAL, vinculada ao revendedor)
      const defaultEntitlements = [
        "agent_execution",
        "preview_server",
        "file_manipulation",
        "cloud_supabase",
        "cloud_github",
        "cloud_vercel",
      ];

      const { data: newLic, error: insertError } = await supabaseAdmin
        .from("licenses")
        .insert({
          key_hash,
          key_mask,
          plan: sale.plan,
          status: "active",
          max_devices: 1,
          expires_at: expiresAt,
          entitlements: defaultEntitlements,
          customer_name: finalCustomerName,
          customer_email: finalCustomerEmail,
          customer_whatsapp: finalCustomerWhatsapp,
          license_type: "NORMAL",
          reseller_id: reseller.id,
          encrypted_key: encryptedKey,
        })
        .select("id, key_mask, plan, status, expires_at, created_at")
        .single();

      if (insertError || !newLic) {
        console.error("[reseller-api] Erro ao criar licença comercial para venda:", insertError);
        return json({ ok: false, message: insertError?.message || "Erro ao gerar licença comercial no banco de dados." }, 500);
      }

      // 8. Registro de evento de emissão da licença
      await supabaseAdmin.from("license_events").insert({
        license_id: newLic.id,
        device_id: "00000000000000000000000000000000",
        event_type: "generate",
        ip_address: extractIp(req),
        metadata: {
          action: "reseller_fulfill_sale",
          reseller_id: reseller.id,
          sale_id: sale.id,
          plan: sale.plan,
        },
      });

      // 9. Envio exclusivo da chave completa por e-mail ao cliente
      const emailResult = await emailClient.sendLicenseDelivery({
        customerName: finalCustomerName,
        customerEmail: finalCustomerEmail,
        licenseKey: plainKey,
        plan: sale.plan,
        maxDevices: 1,
        license_type: "NORMAL",
      });

      // 10. Atualiza a venda para status = 'license_delivered' e vincula o license_id
      await supabaseAdmin
        .from("reseller_sales")
        .update({
          status: "license_delivered",
          license_id: newLic.id,
          customer_name: finalCustomerName,
          customer_email: finalCustomerEmail,
          customer_whatsapp: finalCustomerWhatsapp,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sale.id);

      // Resposta ao revendedor: retorna apenas máscara e identificadores (NUNCA a chave em texto claro)
      return json({
        ok: true,
        message: "Licença emitida e enviada ao cliente com sucesso.",
        sale_id: sale.id,
        license_id: newLic.id,
        key_mask: newLic.key_mask,
        plan: newLic.plan,
        customer_email: finalCustomerEmail,
        email_sent: emailResult.ok,
      });
    }

    if (action === "save_price_settings") {
      const { prices } = body;
      if (!prices || typeof prices !== "object") {
        return json({ ok: false, message: "Objeto 'prices' obrigatório." }, 400);
      }

      const upsertRows = [];
      const updatedSettings = [];
      const officialPricing = await getOfficialPricing(supabaseAdmin);

      for (const plan of ["MONTHLY", "QUARTERLY", "ANNUAL"] as const) {
        const officialNekoCost = officialPricing[plan]?.neko_cost ?? OFFICIAL_NEKO_COSTS[plan];
        const rawVal = prices[plan];
        const resalePrice = typeof rawVal === "number" ? rawVal : parseFloat(rawVal);

        if (Number.isNaN(resalePrice) || resalePrice < officialNekoCost) {
          return json({
            ok: false,
            error_code: "INVALID_PRICE",
            message: `O preço de venda não pode ser inferior ao custo NekoAI (mínimo R$${officialNekoCost.toFixed(2).replace(".", ",")} para o plano ${plan}).`,
          }, 400);
        }

        upsertRows.push({
          reseller_id: reseller.id,
          plan,
          neko_cost: officialNekoCost,
          resale_price: resalePrice,
          updated_at: new Date().toISOString(),
        });

        updatedSettings.push({
          plan,
          neko_cost: officialNekoCost,
          resale_price: resalePrice,
          profit: Number((resalePrice - officialNekoCost).toFixed(2)),
        });
      }

      const { error: upsertErr } = await supabaseAdmin
        .from("reseller_price_settings")
        .upsert(upsertRows, { onConflict: "reseller_id,plan" });

      if (upsertErr) {
        console.error("[reseller-api] Erro ao salvar reseller_price_settings:", upsertErr);
        return json({ ok: false, message: "Erro de banco de dados ao salvar preços." }, 500);
      }

      return json({ ok: true, message: "Configuração de preços salva com sucesso.", settings: updatedSettings });
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: REENVIAR LICENÇA PARA CLIENTE DO REVENDEDOR
    // --------------------------------------------------------------------------
    if (action === "resend_license") {
      const { license_id, customer_email, plain_key } = body;

      if (!license_id) {
        return json({ ok: false, message: "license_id obrigatório." }, 400);
      }

      // 1. Busca licença e valida se pertence estritamente a este revendedor autenticado
      const { data: lic, error: licErr } = await supabaseAdmin
        .from("licenses")
        .select("id, encrypted_key, key_mask, customer_name, customer_email, plan, max_devices, license_type, expires_at, reseller_id")
        .eq("id", license_id)
        .eq("reseller_id", reseller.id)
        .single();

      if (licErr || !lic) {
        return json({ ok: false, message: "Licença não encontrada ou não pertencente à sua conta de revendedor." }, 404);
      }

      // Validação estrita: licença de teste expirada não pode ser reenviada
      if (lic.license_type === "TEST") {
        const nowMs = Date.now();
        const expMs = lic.expires_at ? new Date(lic.expires_at).getTime() : 0;
        if (!expMs || expMs <= nowMs) {
          return json({
            ok: false,
            code: "TEST_LICENSE_EXPIRED",
            error_code: "TEST_LICENSE_EXPIRED",
            message: "Esta licença de teste está expirada e não pode ser reenviada.",
          }, 400);
        }
      }

      const targetEmail = (customer_email || lic.customer_email)?.trim().toLowerCase();
      const targetName = lic.customer_name || "Cliente";
      const targetPlan = lic.plan || "ANNUAL";
      const targetDevices = lic.max_devices || 1;
      const licType = lic.license_type || "NORMAL";

      let targetKey = plain_key ? plain_key.trim().toUpperCase() : "";

      // 2. Se a chave não foi fornecida, tenta descriptografar a chave armazenada
      const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");
      if (!targetKey && lic.encrypted_key && adminSecret) {
        const decrypted = await decryptLicenseKey(lic.encrypted_key, adminSecret);
        if (decrypted) {
          targetKey = decrypted;
        }
      }

      // 3. Validação: formato válido da chave
      const isValidNormal = /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(targetKey);
      const isValidTest = /^NEKO-TEST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(targetKey);
      const isLegacyTest = /^NEKO-TEST-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(targetKey);

      if (!targetKey || (!isValidNormal && !isValidTest && !isLegacyTest)) {
        return json({
          ok: false,
          message: "A chave completa não pôde ser recuperada para esta licença legada.",
          code: "KEY_UNAVAILABLE",
        }, 400);
      }

      if (!targetEmail || !targetEmail.includes("@")) {
        return json({ ok: false, message: "E-mail de destino ausente ou inválido." }, 400);
      }

      // 4. Reenvia utilizando o cliente de e-mail canônico oficial
      const emailResult = await emailClient.sendLicenseDelivery({
        customerName: targetName,
        customerEmail: targetEmail,
        licenseKey: targetKey,
        plan: targetPlan,
        maxDevices: targetDevices,
        license_type: licType,
      });

      // 5. Registra evento de auditoria em license_events
      await supabaseAdmin.from("license_events").insert({
        license_id: lic.id,
        device_id: "00000000000000000000000000000000",
        event_type: emailResult.ok ? "validate" : "failed_attempt",
        ip_address: extractIp(req),
        metadata: {
          action: "reseller_resend_license_email",
          reseller_id: reseller.id,
          customer_email: targetEmail,
          email_id: emailResult.email_id || null,
          error_code: emailResult.error_code || null,
        },
      });

      return json({
        ok: emailResult.ok,
        email_id: emailResult.email_id,
        message: emailResult.ok ? "Licença reenviada com sucesso." : "Não foi possível enviar o e-mail. Tente novamente.",
      }, emailResult.ok ? 200 : 400);
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: ATUALIZAR PERFIL DO REVENDEDOR (NOME, WHATSAPP E CPF)
    // --------------------------------------------------------------------------
    if (action === "update_profile") {
      const { name, phone, cpf } = body;
      const updates: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };

      if (typeof name === "string") {
        const cleanName = name.trim();
        if (!cleanName) {
          return json({ ok: false, message: "O nome não pode estar em branco." }, 400);
        }
        updates.name = cleanName;
      }

      if (typeof phone === "string" || phone === null) {
        updates.phone = phone ? phone.trim() : null;
      }

      let normalizedCpf: string | null = null;
      if (typeof cpf === "string" && cpf.trim() !== "") {
        const cleanDigits = cpf.replace(/\D/g, "");
        if (!validateCpf(cleanDigits)) {
          return json({ ok: false, error_code: "INVALID_CPF", message: "CPF inválido. Forneça um CPF válido com 11 dígitos." }, 400);
        }
        normalizedCpf = cleanDigits;
      } else if (cpf === null) {
        normalizedCpf = null;
      }

      // Atualiza estritamente o revendedor derivado da sessão autenticada (usando id e user_id)
      const { data: updatedReseller, error: updateErr } = await supabaseAdmin
        .from("resellers")
        .update(updates)
        .eq("id", reseller.id)
        .select("id, user_id, name, email, phone, status")
        .maybeSingle();

      if (updateErr) {
        console.error("[reseller-api] Erro ao atualizar perfil do revendedor:", updateErr);
        return json({ ok: false, message: updateErr.message || "Erro de banco de dados ao atualizar perfil." }, 500);
      }

      if (!updatedReseller) {
        console.error("[reseller-api] Nenhum revendedor foi atualizado para id:", reseller.id);
        return json({ ok: false, message: "Registro do revendedor não encontrado para atualização." }, 404);
      }

      // Sincroniza metadados do usuário no Supabase Auth mantendo email e credenciais intactos
      if (user) {
        const metadataUpdates: Record<string, any> = {
          ...user.user_metadata,
          name: updates.name ?? user.user_metadata?.name,
          phone: updates.phone ?? user.user_metadata?.phone,
        };
        if (normalizedCpf !== null) {
          metadataUpdates.cpf = normalizedCpf;
        }
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          user_metadata: metadataUpdates,
        }).catch((err) => {
          console.warn("[reseller-api] Aviso ao sincronizar metadados no Supabase Auth:", err);
        });
      }

      const returnedReseller = {
        ...updatedReseller,
        cpf: normalizedCpf !== null ? normalizedCpf : (user?.user_metadata?.cpf || null),
      };

      return json({
        ok: true,
        message: "Configurações salvas com sucesso.",
        reseller: returnedReseller,
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: REGISTRO/ATUALIZAÇÃO DE SESSÃO ATIVA (register_session)
    // --------------------------------------------------------------------------
    if (action === "register_session") {
      try {
        const userAgent = req.headers.get("user-agent") || body.user_agent || "";
        const { browser, os } = parseUserAgent(userAgent);
        const ip = extractIp(req);

        // Extrai headers de geolocalização se fornecidos pelo proxy/edge (sem dados inventados)
        const city = req.headers.get("cf-ipcity") || req.headers.get("x-vercel-ip-city");
        const region = req.headers.get("cf-region") || req.headers.get("x-vercel-ip-country-region");
        const country = req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country");
        const approximateLocation = [city, region, country].filter(Boolean).join(", ") || null;

        // Session ID prioritariamente do JWT; se ausente, do body se UUID válido
        const sessionIdToUse = currentSessionId || (body.session_id && /^[0-9a-f-]{36}$/i.test(body.session_id) ? body.session_id : null);

        if (!sessionIdToUse) {
          return json({ ok: false, error_code: "MISSING_SESSION_ID", message: "Não foi possível identificar o ID da sessão." }, 400);
        }

        const deviceName = body.device_name || `Novo login em ${browser}`;

        const upsertPayload: Record<string, any> = {
          reseller_id: reseller.id,
          session_id: sessionIdToUse,
          device_name: deviceName,
          browser,
          operating_system: os,
          user_agent: userAgent ? userAgent.slice(0, 500) : null,
          ip_address: ip !== "unknown" ? ip : null,
          approximate_location: approximateLocation,
          is_revoked: false,
          last_active_at: new Date().toISOString(),
        };

        const { data: savedSession, error: upsertErr } = await supabaseAdmin
          .from("reseller_sessions")
          .upsert(upsertPayload, { onConflict: "session_id" })
          .select("id, session_id, device_name, browser, operating_system, ip_address, approximate_location, is_revoked, created_at, last_active_at")
          .single();

        if (upsertErr) {
          console.warn("[reseller-api] Erro ao registrar reseller_sessions (possível tabela inexistente):", upsertErr);
          return json({ ok: true, registered: false, note: "Sessão não persistida (migration pendente)" });
        }

        return json({
          ok: true,
          registered: true,
          session: {
            ...savedSession,
            is_current: true,
          },
        });
      } catch (err: any) {
        console.warn("[reseller-api] Exceção em register_session:", err);
        return json({ ok: true, registered: false, note: err?.message });
      }
    }

    // --------------------------------------------------------------------------
    // AÇÃO POST: REVOGAÇÃO DE SESSÃO ESPECÍFICA (revoke_session)
    // --------------------------------------------------------------------------
    if (action === "revoke_session") {
      const { session_record_id, session_id: targetSessionId } = body;
      if (!session_record_id && !targetSessionId) {
        return json({ ok: false, error_code: "INVALID_PARAMS", message: "ID da sessão a revogar não informado." }, 400);
      }

      try {
        // Busca a sessão garantindo estritamente que pertence a este revendedor (multi-tenant safety)
        let query = supabaseAdmin
          .from("reseller_sessions")
          .select("id, session_id, reseller_id, is_revoked")
          .eq("reseller_id", reseller.id);

        if (session_record_id) {
          query = query.eq("id", session_record_id);
        } else if (targetSessionId) {
          query = query.eq("session_id", targetSessionId);
        }

        const { data: targetRecord, error: findErr } = await query.maybeSingle();

        if (findErr) {
          return json({ ok: false, message: findErr.message }, 500);
        }

        if (!targetRecord) {
          return json({ ok: false, error_code: "SESSION_NOT_FOUND", message: "Dispositivo não encontrado ou não pertence a esta conta." }, 404);
        }

        const nowIso = new Date().toISOString();
        const { error: revokeErr } = await supabaseAdmin
          .from("reseller_sessions")
          .update({
            is_revoked: true,
            revoked_at: nowIso,
          })
          .eq("id", targetRecord.id)
          .eq("reseller_id", reseller.id);

        if (revokeErr) {
          return json({ ok: false, message: revokeErr.message }, 500);
        }

        return json({
          ok: true,
          message: "Dispositivo desconectado com sucesso.",
          revoked_id: targetRecord.id,
        });
      } catch (err: any) {
        console.error("[reseller-api] Exceção em revoke_session:", err);
        return json({ ok: false, message: err?.message || "Erro ao revogar sessão." }, 500);
      }
    }

    return json({ ok: false, message: "Ação POST desconhecida." }, 400);
  }

  return json({ ok: false, message: "Método não suportado." }, 405);
  } catch (err: any) {
    console.error("[reseller-api] Exceção inesperada:", err);
    return json({ ok: false, message: err?.message || "Erro interno do servidor." }, 500);
  }
});
