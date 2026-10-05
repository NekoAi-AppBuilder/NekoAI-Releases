// supabase/functions/admin-sales/index.ts
// Edge Function administrativa de gerenciamento e auditoria unificada de vendas NekoAI

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept, x-requested-with",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const OFFICIAL_NEKO_COSTS: Record<string, number> = {
  MONTHLY: 39.00,
  QUARTERLY: 69.00,
  ANNUAL: 197.00,
};

const DEFAULT_RESALE_PRICES: Record<string, number> = {
  MONTHLY: 79.00,
  QUARTERLY: 149.00,
  ANNUAL: 397.00,
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
  // 1. Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  // 2. Validação HMAC do Administrador
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
      const action = url.searchParams.get("action");

      // AÇÃO: DETALHES DE UMA VENDA ESPECÍFICA
      if (action === "get_details") {
        const saleId = url.searchParams.get("sale_id")?.trim();
        if (!saleId) return json({ ok: false, message: "sale_id obrigatório." }, 400);

        // 1. Tentar buscar em reseller_sales
        const { data: rSale } = await supabaseAdmin
          .from("reseller_sales")
          .select("*")
          .eq("id", saleId)
          .maybeSingle();

        if (rSale) {
          // Buscar revendedor
          let resellerName = "Revendedor";
          if (rSale.reseller_id) {
            const { data: resData } = await supabaseAdmin
              .from("resellers")
              .select("id, name, email")
              .eq("id", rSale.reseller_id)
              .maybeSingle();
            if (resData?.name) resellerName = resData.name;
          }

          // Buscar licença se houver
          let licenseKeyMask: string | null = null;
          let licenseStatus: string | null = null;
          if (rSale.license_id) {
            const { data: licData } = await supabaseAdmin
              .from("licenses")
              .select("id, key_mask, status")
              .eq("id", rSale.license_id)
              .maybeSingle();
            if (licData) {
              licenseKeyMask = licData.key_mask;
              licenseStatus = licData.status;
            }
          }

          const salePrice = Number(rSale.resale_price_snapshot || 0);
          const nekoCost = Number(rSale.neko_cost_snapshot || 0);
          const resellerProfit = Number(rSale.profit_snapshot || 0);
          const isPaid = rSale.status === "paid" || rSale.status === "license_delivered";
          const adminProfit = isPaid ? nekoCost : 0;

          return json({
            ok: true,
            sale: {
              id: rSale.id,
              origin: "Revendedor",
              reseller_id: rSale.reseller_id,
              reseller_name: resellerName,
              plan: rSale.plan,
              sale_price: nekoCost,
              neko_cost: 0,
              reseller_profit: resellerProfit,
              admin_profit: adminProfit,
              reseller_resale_price: salePrice,
              status: rSale.status,
              customer_name: rSale.customer_name || "Cliente",
              customer_email: rSale.customer_email || "—",
              customer_whatsapp: rSale.customer_whatsapp || null,
              mp_payment_id: rSale.mp_payment_id || null,
              mp_external_reference: rSale.mp_external_reference || null,
              license_id: rSale.license_id || null,
              license_key_mask: licenseKeyMask,
              license_status: licenseStatus,
              expires_at: rSale.expires_at || null,
              paid_at: rSale.paid_at || null,
              created_at: rSale.created_at,
            },
          });
        }

        // 2. Se não estiver em reseller_sales, buscar em licenses (Venda Direta)
        const { data: dLic } = await supabaseAdmin
          .from("licenses")
          .select("*")
          .eq("id", saleId)
          .maybeSingle();

        if (dLic) {
          const directPrice = DEFAULT_RESALE_PRICES[dLic.plan] || 79.00;
          const isPaid = dLic.status === "active";

          return json({
            ok: true,
            sale: {
              id: dLic.id,
              origin: "NekoAI Admin",
              reseller_id: null,
              reseller_name: "—",
              plan: dLic.plan,
              sale_price: directPrice,
              neko_cost: 0,
              reseller_profit: 0,
              admin_profit: isPaid ? directPrice : 0,
              status: isPaid ? "paid" : (dLic.status === "expired" ? "expired" : "cancelled"),
              customer_name: dLic.customer_name || "Cliente",
              customer_email: dLic.customer_email || "—",
              customer_whatsapp: dLic.customer_whatsapp || null,
              mp_payment_id: null,
              mp_external_reference: null,
              license_id: dLic.id,
              license_key_mask: dLic.key_mask,
              license_status: dLic.status,
              expires_at: dLic.expires_at || null,
              paid_at: dLic.created_at,
              created_at: dLic.created_at,
            },
          });
        }

        return json({ ok: false, message: "Venda não encontrada." }, 404);
      }

      // LISTAGEM PRINCIPAL UNIFICADA DE VENDAS
      const search = url.searchParams.get("search")?.trim().toLowerCase() || "";
      const rawOrigin = url.searchParams.get("origin")?.trim().toLowerCase();
      const originFilter = (!rawOrigin || rawOrigin === "all") ? null : rawOrigin;

      const rawReseller = url.searchParams.get("reseller_id")?.trim();
      const resellerFilter = (!rawReseller || rawReseller === "all") ? null : rawReseller;

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

      // 1. Buscar todas as fontes em paralelo
      const [salesRes, licensesRes, resellersRes] = await Promise.all([
        supabaseAdmin
          .from("reseller_sales")
          .select("*")
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("licenses")
          .select("id, key_mask, plan, status, license_type, reseller_id, customer_name, customer_email, customer_whatsapp, created_at")
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("resellers")
          .select("id, name, email")
          .order("name", { ascending: true }),
      ]);

      const allResellerSales = salesRes.data || [];
      const allLicenses = licensesRes.data || [];
      const allResellers = resellersRes.data || [];

      // Mapeamento de revendedores
      const resellerMap = new Map<string, { id: string; name: string; email: string }>();
      allResellers.forEach((r: any) => resellerMap.set(r.id, r));

      // Conjunto de licenças já vinculadas a vendas de revendedores
      const linkedLicenseIds = new Set<string>();
      allResellerSales.forEach((s: any) => {
        if (s.license_id) linkedLicenseIds.add(s.license_id);
      });

      const unifiedSales: any[] = [];

      // 2. Incorporar vendas de revendedores
      allResellerSales.forEach((s: any) => {
        const resalePrice = Number(s.resale_price_snapshot || 0);
        const nekoCost = Number(s.neko_cost_snapshot || 0);
        const profit = Number(s.profit_snapshot || 0);
        const isPaid = s.status === "paid" || s.status === "license_delivered";
        const adminProfit = isPaid ? nekoCost : 0;

        unifiedSales.push({
          id: s.id,
          origin: "Revendedor",
          reseller_id: s.reseller_id,
          reseller_name: resellerMap.get(s.reseller_id)?.name || "Revendedor",
          plan: s.plan,
          sale_price: nekoCost,
          neko_cost: 0,
          reseller_profit: profit,
          admin_profit: adminProfit,
          status: s.status,
          customer_name: s.customer_name || "Cliente",
          customer_email: s.customer_email || "—",
          customer_whatsapp: s.customer_whatsapp || null,
          mp_payment_id: s.mp_payment_id || null,
          mp_external_reference: s.mp_external_reference || null,
          license_id: s.license_id || null,
          paid_at: s.paid_at || null,
          created_at: s.created_at,
          reseller_resale_price: resalePrice,
        });
      });

      // 3. Incorporar vendas diretas (licenças comerciais sem vínculo com revendedor)
      allLicenses.forEach((lic: any) => {
        if (lic.reseller_id) return; // Venda de revenda já coberta
        if (lic.license_type === "TEST") return; // Licença de teste não é venda comercial
        if (linkedLicenseIds.has(lic.id)) return; // Já vinculada

        const directPrice = DEFAULT_RESALE_PRICES[lic.plan] || 79.00;
        const isPaid = lic.status === "active";

        unifiedSales.push({
          id: lic.id,
          origin: "NekoAI Admin",
          reseller_id: null,
          reseller_name: "—",
          plan: lic.plan,
          sale_price: directPrice,
          neko_cost: 0,
          reseller_profit: 0,
          admin_profit: isPaid ? directPrice : 0,
          status: isPaid ? "paid" : (lic.status === "expired" ? "expired" : "cancelled"),
          customer_name: lic.customer_name || "Cliente",
          customer_email: lic.customer_email || "—",
          customer_whatsapp: lic.customer_whatsapp || null,
          mp_payment_id: null,
          mp_external_reference: null,
          license_id: lic.id,
          paid_at: lic.created_at,
          created_at: lic.created_at,
        });
      });

      // 4. Aplicar Filtros
      let filtered = unifiedSales;

      // Busca por texto
      if (search) {
        filtered = filtered.filter((s) => {
          const name = (s.customer_name || "").toLowerCase();
          const email = (s.customer_email || "").toLowerCase();
          const whatsapp = (s.customer_whatsapp || "").toLowerCase();
          const reseller = (s.reseller_name || "").toLowerCase();
          const mpId = (s.mp_payment_id || "").toLowerCase();
          const ref = (s.mp_external_reference || "").toLowerCase();
          return (
            name.includes(search) ||
            email.includes(search) ||
            whatsapp.includes(search) ||
            reseller.includes(search) ||
            mpId.includes(search) ||
            ref.includes(search)
          );
        });
      }

      // Filtro Origem
      if (originFilter) {
        if (originFilter === "direct" || originFilter === "nekoai admin") {
          filtered = filtered.filter((s) => s.origin === "NekoAI Admin");
        } else if (originFilter === "reseller" || originFilter === "revendedor") {
          filtered = filtered.filter((s) => s.origin === "Revendedor");
        }
      }

      // Filtro Revendedor
      if (resellerFilter) {
        filtered = filtered.filter((s) => s.reseller_id === resellerFilter);
      }

      // Filtro Plano
      if (planFilter) {
        filtered = filtered.filter((s) => s.plan?.toUpperCase() === planFilter);
      }

      // Filtro Status
      if (statusFilter) {
        filtered = filtered.filter((s) => s.status?.toLowerCase() === statusFilter);
      }

      // Filtro Data De / Até
      if (dateFrom) {
        const fromTime = new Date(dateFrom).getTime();
        filtered = filtered.filter((s) => new Date(s.created_at).getTime() >= fromTime);
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        const toTime = toDate.getTime();
        filtered = filtered.filter((s) => new Date(s.created_at).getTime() <= toTime);
      }

      // 5. Cálculo das métricas consolidadas (sobre todo o conjunto ou filtrado)
      const totalSalesCount = unifiedSales.length;
      let completedSalesCount = 0;
      let totalRevenue = 0;
      let totalAdminProfit = 0;
      let totalResellerProfit = 0;

      unifiedSales.forEach((s) => {
        if (s.status === "paid" || s.status === "license_delivered") {
          completedSalesCount += 1;
          totalRevenue += s.sale_price;
          totalAdminProfit += s.admin_profit;
          totalResellerProfit += s.reseller_profit;
        }
      });

      // 6. Ordenação por data mais recente
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // 7. Paginação
      const totalItems = filtered.length;
      const totalPages = Math.ceil(totalItems / limit) || 1;
      const startIndex = (page - 1) * limit;
      const paginatedSales = filtered.slice(startIndex, startIndex + limit);

      return json({
        ok: true,
        sales: paginatedSales,
        stats: {
          total_sales: totalSalesCount,
          completed_sales: completedSalesCount,
          total_revenue: totalRevenue,
          admin_profit: totalAdminProfit,
          reseller_profit: totalResellerProfit,
        },
        pagination: {
          page,
          limit,
          total_items: totalItems,
          total_pages: totalPages,
        },
        resellers: allResellers.map((r: any) => ({ id: r.id, name: r.name })),
      });
    }

    return json({ ok: false, message: "Método não suportado." }, 405);
  } catch (err: any) {
    console.error("[admin-sales] Erro interno:", err);
    return json({ ok: false, message: `Erro interno: ${err?.message || err}` }, 500);
  }
});
