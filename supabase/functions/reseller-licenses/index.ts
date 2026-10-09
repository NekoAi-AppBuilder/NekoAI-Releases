// supabase/functions/reseller-licenses/index.ts
// Edge Function isolada e segura para consulta e gestão de Licenças do Revendedor NekoAI

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
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
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

async function verifyAdminToken(
  authHeader: string | null,
  adminSecret: string
): Promise<{ valid: boolean; reason?: string }> {
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
      console.error("[reseller-licenses] Configuração ausente: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.");
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

    // AUTORIDADE ABSOLUTA: reseller_id derivado estritamente da sessão
    const authenticatedResellerId = reseller.id;
    const url = new URL(req.url);

    // ============================================================================
    // GET: LISTAGEM, DETALHES E MÉTRICAS DE LICENÇAS DO REVENDEDOR
    // ============================================================================
    if (req.method === "GET") {
      const action = url.searchParams.get("action");

      // AÇÃO: DETALHES DE UMA LICENÇA
      if (action === "get_details") {
        const licenseId = url.searchParams.get("license_id")?.trim();
        if (!licenseId) {
          return json({ ok: false, message: "license_id ausente." }, 400);
        }

        // Busca licença pertencente ESTRITAMENTE a este revendedor
        const { data: lic, error: licErr } = await supabaseAdmin
          .from("licenses")
          .select("id, key_mask, plan, status, max_devices, expires_at, entitlements, customer_name, customer_email, customer_whatsapp, created_at, updated_at, license_type, reseller_id")
          .eq("id", licenseId)
          .eq("reseller_id", authenticatedResellerId)
          .maybeSingle();

        if (licErr) {
          return json({ ok: false, message: licErr.message }, 500);
        }

        if (!lic) {
          return json({ ok: false, message: "Licença não encontrada ou não pertencente à sua conta de revendedor." }, 404);
        }

        // Busca dispositivos ativos vinculados a esta licença
        const { data: activations } = await supabaseAdmin
          .from("license_activations")
          .select("device_id, device_name, last_validated_at")
          .eq("license_id", lic.id)
          .order("created_at", { ascending: true });

        // Busca venda associada a esta licença (se houver) para este revendedor
        const { data: sale } = await supabaseAdmin
          .from("reseller_sales")
          .select("id, plan, neko_cost_snapshot, resale_price_snapshot, profit_snapshot, status, paid_at, created_at")
          .eq("license_id", lic.id)
          .eq("reseller_id", authenticatedResellerId)
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

      // AÇÃO PADRÃO: LISTAGEM DE LICENÇAS COM FILTROS E MÉTRICAS
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
      const planParam = url.searchParams.get("plan")?.trim().toUpperCase();
      const pageStr = url.searchParams.get("page");
      const limitStr = url.searchParams.get("limit");

      const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
      const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

      // 1. Busca TODAS as licenças deste revendedor para calcular métricas consistentes
      const { data: allResellerLicenses, error: allErr } = await supabaseAdmin
        .from("licenses")
        .select("id, key_mask, plan, status, max_devices, expires_at, entitlements, customer_name, customer_email, customer_whatsapp, created_at, updated_at, license_type")
        .eq("reseller_id", authenticatedResellerId)
        .order("created_at", { ascending: false });

      if (allErr) {
        return json({ ok: false, message: allErr.message }, 500);
      }

      const allList = allResellerLicenses || [];
      const nowMs = Date.now();

      // Métricas reais isoladas do revendedor
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
      const testLicenses = allList.filter((l: any) => l.license_type === "TEST").length;

      // 2. Aplicação de Filtros na Listagem
      let filtered = allList;

      // Filtro de Busca (nome, e-mail, whatsapp, chave/máscara)
      if (search) {
        filtered = filtered.filter((l: any) => {
          const n = (l.customer_name || "").toLowerCase();
          const e = (l.customer_email || "").toLowerCase();
          const w = (l.customer_whatsapp || "").toLowerCase();
          const k = (l.key_mask || "").toLowerCase();
          return n.includes(search) || e.includes(search) || w.includes(search) || k.includes(search);
        });
      }

      // Filtro de Status
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

      // Filtro de Plano
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
          message: emailResult.ok ? "Licença reenviada com sucesso." : "Não foi possível enviar o e-mail. Tente novamente.",
        }, emailResult.ok ? 200 : 400);
      }

      return json({ ok: false, message: "Ação não suportada." }, 400);
    }

    return json({ ok: false, message: "Método HTTP não suportado." }, 405);
  } catch (err: any) {
    console.error("[reseller-licenses] Exceção:", err);
    return json({ ok: false, message: err?.message || "Erro interno." }, 500);
  }
});
