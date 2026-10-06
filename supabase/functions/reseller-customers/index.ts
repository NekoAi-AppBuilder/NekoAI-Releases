// supabase/functions/reseller-customers/index.ts
// Edge Function isolada e segura para consulta e gestão de Clientes do Revendedor NekoAI

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { emailClient } from "../_shared/email/email-client.ts";
import { decryptLicenseKey } from "../_shared/license-crypto.ts";

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

function extractIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
         req.headers.get("cf-connecting-ip") ||
         req.headers.get("x-real-ip") ||
         "unknown";
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

async function verifyAdminToken(authHeader: string | null, adminSecret: string): Promise<{ valid: boolean; reason?: string }> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { valid: false, reason: "Header Authorization ausente ou sem formato Bearer" };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Token com formato inválido" };
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
    if (!isValid) return { valid: false, reason: "Assinatura HMAC inválida" };

    const payload = JSON.parse(base64UrlToString(b64Payload));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) {
      return { valid: false, reason: "Token expirado" };
    }
    if (payload.role !== "neko_admin") {
      return { valid: false, reason: "Role incorreta" };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Exceção HMAC: ${err?.message || err}` };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("[reseller-customers] Configuração ausente: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.");
      return json({ ok: false, error_code: "INTERNAL_ERROR", message: "Erro de configuração no servidor." }, 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

    // 1. Autorização Obrigatória via JWT ou Admin Token
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    let reseller: { id: string; name: string; email: string; phone?: string | null; status: string } | null = null;
    let isAuthUser = false;

    // Tentativa A: Supabase Auth User JWT (Fluxo padrão do revendedor)
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (user && !authErr) {
      isAuthUser = true;
      const { data: foundReseller } = await supabaseAdmin
        .from("resellers")
        .select("id, name, email, phone, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (foundReseller) {
        reseller = foundReseller;
      }
    }

    // Tentativa B: NekoAI Admin Session Token (Para suporte e testes administrativos)
    if (!reseller && !isAuthUser && adminSecret) {
      const adminCheck = await verifyAdminToken(authHeader, adminSecret.trim());
      if (adminCheck.valid) {
        const { data: activeReseller } = await supabaseAdmin
          .from("resellers")
          .select("id, name, email, phone, status")
          .eq("status", "active")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (activeReseller) {
          reseller = activeReseller;
        } else {
          reseller = {
            id: "00000000-0000-0000-0000-000000000000",
            name: "NekoAI Admin",
            email: "admin@nekoai.com",
            status: "active",
          };
        }
      }
    }

    // Usuário autenticado pelo Supabase Auth mas não é revendedor
    if (isAuthUser && !reseller) {
      return json({ ok: false, error_code: "FORBIDDEN", message: "Você não possui permissão para acessar esta área." }, 403);
    }

    // Não autenticado
    if (!reseller) {
      return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
    }

    // Revendedor inativo ou revogado
    if (reseller.status !== "active") {
      return json({ ok: false, error_code: "RESELLER_INACTIVE", message: "Você não possui permissão para acessar esta área." }, 403);
    }

    // 2. Verificação de Revogação de Sessão Ativa (quando autenticado via JWT de revendedor)
    if (isAuthUser) {
      const currentSessionId = extractSessionIdFromJwt(token);
      if (currentSessionId) {
        try {
          const { data: sessionRec, error: sessionErr } = await supabaseAdmin
            .from("reseller_sessions")
            .select("id, is_revoked")
            .eq("session_id", currentSessionId)
            .maybeSingle();

          if (!sessionErr && sessionRec && sessionRec.is_revoked) {
            console.warn(`[reseller-customers] Sessão revogada detectada (${currentSessionId}) para revendedor ${reseller.id}. Rejeitando com 401.`);
            return json({
              ok: false,
              error_code: "SESSION_REVOKED",
              message: "Esta sessão foi desconectada em outro dispositivo. Faça login novamente.",
            }, 401);
          }
        } catch (err) {
          console.warn("[reseller-customers] Falha silenciosa ao verificar reseller_sessions:", err);
        }
      }
    }

    // AUTORIDADE ABSOLUTA: reseller_id derivado estritamente da sessão
    const authenticatedResellerId = reseller.id;
    const url = new URL(req.url);

    // ============================================================================
    // GET: LISTAGEM E DETALHES DE CLIENTES DO REVENDEDOR
    // ============================================================================
    if (req.method === "GET") {
      const action = url.searchParams.get("action");

      // AÇÃO: DETALHES DE UM CLIENTE
      if (action === "get_details") {
        const emailParam = url.searchParams.get("email")?.trim().toLowerCase();
        if (!emailParam) {
          return json({ ok: false, message: "E-mail do cliente ausente." }, 400);
        }

        // 1. Busca licenças do cliente pertencentes estritamente a este revendedor
        const { data: clientLicenses, error: licErr } = await supabaseAdmin
          .from("licenses")
          .select("id, key_mask, plan, license_type, status, expires_at, customer_name, customer_email, customer_whatsapp, created_at, updated_at")
          .eq("reseller_id", authenticatedResellerId)
          .ilike("customer_email", emailParam)
          .order("created_at", { ascending: false });

        if (licErr) {
          return json({ ok: false, message: licErr.message }, 500);
        }

        // 2. Busca vendas do cliente pertencentes estritamente a este revendedor
        const { data: clientSales, error: salesErr } = await supabaseAdmin
          .from("reseller_sales")
          .select("id, license_id, plan, neko_cost_snapshot, resale_price_snapshot, profit_snapshot, status, customer_name, customer_email, customer_whatsapp, created_at, paid_at")
          .eq("reseller_id", authenticatedResellerId)
          .ilike("customer_email", emailParam)
          .order("created_at", { ascending: false });

        if (salesErr) {
          return json({ ok: false, message: salesErr.message }, 500);
        }

        const licensesList = clientLicenses || [];
        const salesList = clientSales || [];

        // Proteção contra acesso cruzado: se o cliente não possui nem licença nem venda neste revendedor, retorna 404
        if (licensesList.length === 0 && salesList.length === 0) {
          return json({ ok: false, message: "Cliente não encontrado ou não vinculado à sua revenda." }, 404);
        }

        const sampleLic = licensesList[0];
        const sampleSale = salesList[0];

        const customerName = sampleLic?.customer_name || sampleSale?.customer_name || "Cliente";
        const customerWhatsapp = sampleLic?.customer_whatsapp || sampleSale?.customer_whatsapp || null;

        const hasActiveLicense = licensesList.some((l: any) => {
          if (l.status !== "active") return false;
          if (l.expires_at && new Date(l.expires_at).getTime() <= Date.now()) return false;
          return true;
        });

        const activeLic = licensesList.find((l: any) => l.status === "active" && (!l.expires_at || new Date(l.expires_at).getTime() > Date.now()));
        const effectivePlan = activeLic ? (activeLic.license_type === "TEST" ? "TEST" : activeLic.plan) : (sampleLic?.license_type === "TEST" ? "TEST" : (sampleLic?.plan || sampleSale?.plan || "—"));

        const formattedLicenses = licensesList.map((l: any) => ({
          id: l.id,
          key_mask: l.key_mask,
          plan: l.plan,
          license_type: l.license_type || "NORMAL",
          status: l.status,
          expires_at: l.expires_at,
          created_at: l.created_at,
        }));

        const formattedSales = salesList.map((s: any) => ({
          id: s.id,
          plan: s.plan,
          amount: Number(s.resale_price_snapshot || 0),
          profit: Number(s.profit_snapshot || 0),
          status: s.status,
          created_at: s.created_at || s.paid_at,
        }));

        const createdAt = sampleLic?.created_at || sampleSale?.created_at || new Date().toISOString();

        return json({
          ok: true,
          customer: {
            id: emailParam,
            name: customerName,
            email: emailParam,
            whatsapp: customerWhatsapp,
            plan: effectivePlan,
            status: hasActiveLicense ? "active" : "inactive",
            total_licenses: licensesList.length,
            total_sales: salesList.length,
            created_at: createdAt,
            last_license: sampleLic ? {
              id: sampleLic.id,
              key_mask: sampleLic.key_mask,
              plan: sampleLic.plan,
              status: sampleLic.status,
              expires_at: sampleLic.expires_at,
            } : null,
          },
          licenses: formattedLicenses,
          sales: formattedSales,
        });
      }

      // AÇÃO: LISTAGEM DE CLIENTES COM BUSCA, FILTROS E PAGINAÇÃO
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
      const planParam = url.searchParams.get("plan")?.trim().toUpperCase();
      const pageStr = url.searchParams.get("page");
      const limitStr = url.searchParams.get("limit");

      const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
      const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

      // Busca SOMENTE licenças e vendas associadas ao reseller_id autenticado
      const [licensesRes, salesRes] = await Promise.all([
        supabaseAdmin
          .from("licenses")
          .select("id, key_mask, plan, license_type, status, expires_at, customer_name, customer_email, customer_whatsapp, created_at")
          .eq("reseller_id", authenticatedResellerId)
          .not("customer_email", "is", null)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("reseller_sales")
          .select("id, plan, resale_price_snapshot, profit_snapshot, status, customer_name, customer_email, customer_whatsapp, created_at")
          .eq("reseller_id", authenticatedResellerId)
          .not("customer_email", "is", null)
          .order("created_at", { ascending: false }),
      ]);

      if (licensesRes.error) {
        return json({ ok: false, message: licensesRes.error.message }, 500);
      }
      if (salesRes.error) {
        return json({ ok: false, message: salesRes.error.message }, 500);
      }

      const allLicenses = licensesRes.data || [];
      const allSales = salesRes.data || [];

      // Agregação unificada de clientes por email
      const customerMap = new Map<string, any>();

      // 1. Processa Licenças da Revenda
      allLicenses.forEach((lic: any) => {
        const email = lic.customer_email?.trim().toLowerCase();
        if (!email) return;

        const isLicActive = lic.status === "active" && (!lic.expires_at || new Date(lic.expires_at).getTime() > Date.now());

        if (!customerMap.has(email)) {
          customerMap.set(email, {
            id: email,
            name: lic.customer_name?.trim() || "Cliente",
            email,
            whatsapp: lic.customer_whatsapp?.trim() || null,
            plan: lic.license_type === "TEST" ? "TEST" : (lic.plan || "—"),
            status: isLicActive ? "active" : "inactive",
            total_licenses: 1,
            total_sales: 0,
            created_at: lic.created_at,
            last_license: {
              id: lic.id,
              key_mask: lic.key_mask,
              plan: lic.plan,
              status: lic.status,
              expires_at: lic.expires_at,
            },
            _activeLicenses: isLicActive ? 1 : 0,
          });
        } else {
          const c = customerMap.get(email);
          c.total_licenses += 1;
          if (isLicActive) {
            c.status = "active";
            c._activeLicenses += 1;
            if (c.plan === "—" || c._activeLicenses === 1) {
              c.plan = lic.license_type === "TEST" ? "TEST" : (lic.plan || "—");
            }
          }
          if (!c.whatsapp && lic.customer_whatsapp) c.whatsapp = lic.customer_whatsapp.trim();
          if ((!c.name || c.name === "Cliente") && lic.customer_name) c.name = lic.customer_name.trim();
        }
      });

      // 2. Processa Vendas da Revenda
      allSales.forEach((sale: any) => {
        const email = sale.customer_email?.trim().toLowerCase();
        if (!email) return;

        if (!customerMap.has(email)) {
          customerMap.set(email, {
            id: email,
            name: sale.customer_name?.trim() || "Cliente",
            email,
            whatsapp: sale.customer_whatsapp?.trim() || null,
            plan: sale.plan || "—",
            status: "inactive",
            total_licenses: 0,
            total_sales: 1,
            created_at: sale.created_at,
            last_license: null,
            _activeLicenses: 0,
          });
        } else {
          const c = customerMap.get(email);
          c.total_sales += 1;
          if (!c.whatsapp && sale.customer_whatsapp) c.whatsapp = sale.customer_whatsapp.trim();
          if ((!c.name || c.name === "Cliente") && sale.customer_name) c.name = sale.customer_name.trim();
        }
      });

      let customersList = Array.from(customerMap.values());

      // Estatísticas globais do revendedor
      const totalCustomers = customersList.length;
      const activeCustomers = customersList.filter((c: any) => c.status === "active").length;
      const inactiveCustomers = totalCustomers - activeCustomers;

      // FILTRO: Busca (Nome, E-mail, WhatsApp)
      if (search) {
        customersList = customersList.filter((c: any) => {
          const n = (c.name || "").toLowerCase();
          const e = (c.email || "").toLowerCase();
          const w = (c.whatsapp || "").toLowerCase();
          return n.includes(search) || e.includes(search) || w.includes(search);
        });
      }

      // FILTRO: Status (active, inactive)
      if (statusParam && statusParam !== "all") {
        customersList = customersList.filter((c: any) => c.status === statusParam);
      }

      // FILTRO: Plano (MONTHLY, QUARTERLY, ANNUAL, TEST)
      if (planParam && planParam !== "ALL") {
        customersList = customersList.filter((c: any) => {
          const p = (c.plan || "").toUpperCase();
          if (planParam === "TEST") return p === "TEST";
          if (planParam === "MONTHLY") return p === "MONTHLY";
          if (planParam === "QUARTERLY") return p === "QUARTERLY";
          if (planParam === "ANNUAL") return p === "ANNUAL";
          return p === planParam;
        });
      }

      // Ordenação: mais recentes primeiro
      customersList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // Paginação server-side
      const totalFiltered = customersList.length;
      const totalPages = Math.ceil(totalFiltered / limit) || 1;
      const offset = (page - 1) * limit;
      const paginatedItems = customersList.slice(offset, offset + limit);

      return json({
        ok: true,
        customers: paginatedItems,
        stats: {
          total_customers: totalCustomers,
          active_customers: activeCustomers,
          inactive_customers: inactiveCustomers,
        },
        pagination: {
          page,
          limit,
          total_items: totalFiltered,
          total_pages: totalPages,
        },
      });
    }

    // ============================================================================
    // POST: AÇÕES OPERACIONAIS (REENVIO DE LICENÇA)
    // ============================================================================
    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, message: "JSON inválido." }, 400);
      }

      const { action } = body;

      // AÇÃO: REENVIAR LICENÇA
      if (action === "resend_license") {
        const { license_id, customer_email, plain_key } = body;

        if (!license_id) {
          return json({ ok: false, message: "license_id obrigatório." }, 400);
        }

        // 1. Busca licença e valida se pertence estritamente a este revendedor
        const { data: lic, error: licErr } = await supabaseAdmin
          .from("licenses")
          .select("id, encrypted_key, key_mask, customer_name, customer_email, plan, max_devices, license_type, expires_at, reseller_id")
          .eq("id", license_id)
          .eq("reseller_id", authenticatedResellerId)
          .single();

        if (licErr || !lic) {
          return json({ ok: false, message: "Licença não encontrada ou não pertencente à sua conta de revendedor." }, 404);
        }

        const targetEmail = (customer_email || lic.customer_email)?.trim().toLowerCase();
        const targetName = lic.customer_name || "Cliente";
        const targetPlan = lic.plan || "ANNUAL";
        const targetDevices = lic.max_devices || 1;
        const licType = lic.license_type || "NORMAL";

        let targetKey = plain_key ? plain_key.trim().toUpperCase() : "";

        // 2. Se a chave não foi fornecida, tenta descriptografar a chave armazenada
        if (!targetKey && lic.encrypted_key && adminSecret) {
          const decrypted = await decryptLicenseKey(lic.encrypted_key, adminSecret);
          if (decrypted) {
            targetKey = decrypted;
          }
        }

        // 3. Validação: nunca enviar chave incompleta ou mascarada
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

        // 5. Registra evento de auditoria
        await supabaseAdmin.from("license_events").insert({
          license_id: lic.id,
          device_id: "00000000000000000000000000000000",
          event_type: emailResult.ok ? "validate" : "failed_attempt",
          ip_address: extractIp(req),
          metadata: {
            action: "reseller_resend_license_email",
            reseller_id: authenticatedResellerId,
            customer_email: targetEmail,
            email_id: emailResult.email_id || null,
            error_code: emailResult.error_code || null,
          },
        });

        return json({
          ok: emailResult.ok,
          email_id: emailResult.email_id,
          message: emailResult.ok ? "✓ E-mail enviado com sucesso com os dados da licença." : "Não foi possível enviar o e-mail. Tente novamente.",
        }, emailResult.ok ? 200 : 400);
      }

      return json({ ok: false, message: "Ação não suportada." }, 400);
    }

    return json({ ok: false, message: "Método HTTP não suportado." }, 405);
  } catch (err: any) {
    console.error("[reseller-customers] Exceção:", err);
    return json({ ok: false, message: err?.message || "Erro interno." }, 500);
  }
});
