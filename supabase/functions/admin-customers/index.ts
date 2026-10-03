// supabase/functions/admin-customers/index.ts
// Edge Function administrativa de gerenciamento unificado de clientes NekoAI

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { emailClient } from "../_shared/email/email-client.ts";
import { getOfficialPricing } from "../_shared/pricing/admin-pricing.ts";

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
  // Preflight CORS (OPTIONS): retorno HTTP 200 explícito imediato sem exigir autenticação, HMAC ou segredos
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    console.error("[admin-customers] Configuração ausente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou NEKO_ADMIN_SECRET_KEY.");
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  // Validação de Autorização Administrativa
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const authResult = await verifyAdminToken(authHeader, adminSecret);
  if (!authResult.valid) {
    console.warn(`[admin-customers] Acesso negado: ${authResult.reason}`);
    return json({ ok: false, message: "Acesso administrativo não autorizado ou sessão expirada.", reason: authResult.reason }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  const url = new URL(req.url);

  // ============================================================================
  // GET: LISTAGEM UNIFICADA OU DETALHES DE CLIENTE
  // ============================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action");

    // 1. DETALHES DO CLIENTE
    if (action === "get_details") {
      const emailParam = url.searchParams.get("email")?.trim().toLowerCase();
      if (!emailParam) return json({ ok: false, message: "E-mail do cliente ausente." }, 400);

      // Buscar licenças do cliente
      const { data: licensesData } = await supabaseAdmin
        .from("licenses")
        .select("id, key_mask, plan, license_type, status, expires_at, customer_name, customer_email, customer_whatsapp, reseller_id, created_at, updated_at")
        .ilike("customer_email", emailParam)
        .order("created_at", { ascending: false });

      // Buscar vendas vinculadas ao cliente
      const { data: salesData } = await supabaseAdmin
        .from("reseller_sales")
        .select("id, reseller_id, license_id, plan, neko_cost_snapshot, resale_price_snapshot, profit_snapshot, status, customer_name, customer_email, customer_whatsapp, created_at, paid_at")
        .ilike("customer_email", emailParam)
        .order("created_at", { ascending: false });

      // Buscar revendedor correspondente (se este cliente for ou tiver sido revendedor)
      const { data: resellerSelf } = await supabaseAdmin
        .from("resellers")
        .select("*")
        .ilike("email", emailParam)
        .maybeSingle();

      // Buscar revendedores associados às licenças/vendas para extrair nomes
      const referencedResellerIds = [
        ...new Set([
          ...(licensesData || []).map((l: any) => l.reseller_id),
          ...(salesData || []).map((s: any) => s.reseller_id)
        ].filter(Boolean))
      ];

      const resellerNameMap = new Map<string, string>();
      if (referencedResellerIds.length > 0) {
        const { data: resList } = await supabaseAdmin
          .from("resellers")
          .select("id, name")
          .in("id", referencedResellerIds);
        (resList || []).forEach((r: any) => resellerNameMap.set(r.id, r.name));
      }

      // Consolidar dados do cliente
      const sampleLic = (licensesData || [])[0];
      const sampleSale = (salesData || [])[0];

      const customerName = sampleLic?.customer_name || sampleSale?.customer_name || resellerSelf?.name || "Cliente";
      const customerWhatsapp = sampleLic?.customer_whatsapp || sampleSale?.customer_whatsapp || resellerSelf?.phone || null;
      
      const hasActiveLicense = (licensesData || []).some((l: any) => {
        if (l.status !== "active") return false;
        if (l.expires_at && new Date(l.expires_at).getTime() <= Date.now()) return false;
        return true;
      });

      const customerStatus: "active" | "inactive" = hasActiveLicense ? "active" : "inactive";

      const hasResellerLicense = (licensesData || []).some((l: any) => !!l.reseller_id);
      const primaryResellerId = sampleLic?.reseller_id || sampleSale?.reseller_id || null;
      const primaryResellerName = primaryResellerId ? (resellerNameMap.get(primaryResellerId) || "Revendedor") : "—";
      const origin: "NekoAI Admin" | "Revendedor" = hasResellerLicense || primaryResellerId ? "Revendedor" : "NekoAI Admin";

      const resaleStatus: "active" | "inactive" | "suspended" | "none" = resellerSelf ? resellerSelf.status : "none";
      const hasActiveResale = resaleStatus === "active";

      const createdAt = sampleLic?.created_at || sampleSale?.created_at || resellerSelf?.created_at || new Date().toISOString();

      const formattedLicenses = (licensesData || []).map((l: any) => ({
        id: l.id,
        key_mask: l.key_mask,
        plan: l.plan,
        license_type: l.license_type || "NORMAL",
        status: l.status,
        expires_at: l.expires_at,
        origin: l.reseller_id ? "Revendedor" : "NekoAI Admin",
        reseller_name: l.reseller_id ? (resellerNameMap.get(l.reseller_id) || "Revendedor") : "—",
        created_at: l.created_at,
      }));

      const formattedSales = (salesData || []).map((s: any) => ({
        id: s.id,
        plan: s.plan,
        amount: Number(s.resale_price_snapshot || 0),
        origin: "Revendedor",
        reseller_name: resellerNameMap.get(s.reseller_id) || "Revendedor",
        status: s.status,
        created_at: s.created_at || s.paid_at,
      }));

      return json({
        ok: true,
        customer: {
          id: emailParam,
          name: customerName,
          email: emailParam,
          whatsapp: customerWhatsapp,
          origin,
          reseller_id: primaryResellerId,
          reseller_name: primaryResellerName,
          plan: sampleLic?.plan || sampleSale?.plan || "—",
          status: customerStatus,
          has_active_resale: hasActiveResale,
          reseller_status: resaleStatus,
          reseller_account_id: resellerSelf?.id || null,
          total_licenses: (licensesData || []).length,
          total_sales: (salesData || []).length,
          created_at: createdAt,
        },
        licenses: formattedLicenses,
        sales: formattedSales,
      });
    }

    // 2. LISTAGEM GERAL DE CLIENTES COM BUSCA, FILTROS E PAGINAÇÃO
    const search = url.searchParams.get("search")?.trim().toLowerCase();
    const originParam = url.searchParams.get("origin")?.trim();
    const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
    const planParam = url.searchParams.get("plan")?.trim().toUpperCase();
    const resellerIdParam = url.searchParams.get("reseller_id")?.trim();
    const pageStr = url.searchParams.get("page");
    const limitStr = url.searchParams.get("limit");

    const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
    const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

    // Buscar dados reais das fontes primárias
    const [licensesRes, salesRes, resellersRes] = await Promise.all([
      supabaseAdmin
        .from("licenses")
        .select("id, key_mask, plan, license_type, status, expires_at, customer_name, customer_email, customer_whatsapp, reseller_id, created_at")
        .not("customer_email", "is", null)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("reseller_sales")
        .select("id, reseller_id, plan, resale_price_snapshot, status, customer_name, customer_email, customer_whatsapp, created_at")
        .not("customer_email", "is", null)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("resellers")
        .select("id, user_id, name, email, phone, status, created_at"),
    ]);

    const allLicenses = licensesRes.data || [];
    const allSales = salesRes.data || [];
    const allResellers = resellersRes.data || [];

    // Mapeamentos de Revendedores
    const resellerById = new Map<string, any>();
    const resellerByEmail = new Map<string, any>();
    allResellers.forEach((r: any) => {
      resellerById.set(r.id, r);
      if (r.email) resellerByEmail.set(r.email.trim().toLowerCase(), r);
    });

    // Consolidação Única de Clientes por Email (Sem Duplicação)
    const customerMap = new Map<string, any>();

    // 1. Processar Licenças
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
          origin: lic.reseller_id ? "Revendedor" : "NekoAI Admin",
          reseller_id: lic.reseller_id || null,
          reseller_name: lic.reseller_id ? (resellerById.get(lic.reseller_id)?.name || "Revendedor") : "—",
          plan: lic.license_type === "TEST" ? "TEST" : (lic.plan || "—"),
          status: isLicActive ? "active" : "inactive",
          has_active_resale: false,
          reseller_status: "none",
          reseller_account_id: null,
          total_licenses: 1,
          total_sales: 0,
          created_at: lic.created_at,
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
        // Se possui vínculo com revendedor, atualiza contexto se a licença for ativa
        if (lic.reseller_id && (isLicActive || c.origin === "NekoAI Admin")) {
          c.origin = "Revendedor";
          c.reseller_id = lic.reseller_id;
          c.reseller_name = resellerById.get(lic.reseller_id)?.name || "Revendedor";
        }
      }
    });

    // 2. Processar Vendas
    allSales.forEach((sale: any) => {
      const email = sale.customer_email?.trim().toLowerCase();
      if (!email) return;

      if (!customerMap.has(email)) {
        customerMap.set(email, {
          id: email,
          name: sale.customer_name?.trim() || "Cliente",
          email,
          whatsapp: sale.customer_whatsapp?.trim() || null,
          origin: "Revendedor",
          reseller_id: sale.reseller_id || null,
          reseller_name: sale.reseller_id ? (resellerById.get(sale.reseller_id)?.name || "Revendedor") : "—",
          plan: sale.plan || "—",
          status: "inactive",
          has_active_resale: false,
          reseller_status: "none",
          reseller_account_id: null,
          total_licenses: 0,
          total_sales: 1,
          created_at: sale.created_at,
          _activeLicenses: 0,
        });
      } else {
        const c = customerMap.get(email);
        c.total_sales += 1;
        if (!c.whatsapp && sale.customer_whatsapp) c.whatsapp = sale.customer_whatsapp.trim();
        if ((!c.name || c.name === "Cliente") && sale.customer_name) c.name = sale.customer_name.trim();
      }
    });

    // 3. Cruzamento e Identificação do Estado de Revenda
    customerMap.forEach((c: any, email: string) => {
      const selfReseller = resellerByEmail.get(email);
      if (selfReseller) {
        c.reseller_account_id = selfReseller.id;
        c.reseller_status = selfReseller.status;
        c.has_active_resale = selfReseller.status === "active";
      } else {
        c.reseller_status = "none";
        c.has_active_resale = false;
      }
    });

    // Também incluir revendedores que não possuem licença ou venda ainda, para que apareçam na lista de clientes unificada
    allResellers.forEach((r: any) => {
      const email = r.email?.trim().toLowerCase();
      if (!email || customerMap.has(email)) return;

      // Excluir conta administrativa se nome contiver admin
      if (r.name?.toLowerCase().includes("admin") || email.includes("admin@nekoai.com")) return;

      customerMap.set(email, {
        id: email,
        name: r.name?.trim() || "Revendedor",
        email,
        whatsapp: r.phone?.trim() || null,
        origin: "NekoAI Admin",
        reseller_id: null,
        reseller_name: "—",
        plan: "—",
        status: r.status === "active" ? "active" : "inactive",
        has_active_resale: r.status === "active",
        reseller_status: r.status,
        reseller_account_id: r.id,
        total_licenses: 0,
        total_sales: 0,
        created_at: r.created_at,
        _activeLicenses: 0,
      });
    });

    let customersList = Array.from(customerMap.values());

    // ==========================================
    // FILTROS COMBINÁVEIS
    // ==========================================

    // Busca (Nome, E-mail, WhatsApp)
    if (search) {
      customersList = customersList.filter((c: any) => {
        const n = (c.name || "").toLowerCase();
        const e = (c.email || "").toLowerCase();
        const w = (c.whatsapp || "").toLowerCase();
        return n.includes(search) || e.includes(search) || w.includes(search);
      });
    }

    // Filtro por Origem
    if (originParam && originParam !== "all") {
      if (originParam === "direct" || originParam === "neko_admin" || originParam === "admin") {
        customersList = customersList.filter((c: any) => c.origin === "NekoAI Admin");
      } else if (originParam === "resellers" || originParam === "all_resellers") {
        customersList = customersList.filter((c: any) => c.origin === "Revendedor");
      } else {
        // ID de revendedor específico passado no filtro origin
        customersList = customersList.filter((c: any) => c.reseller_id === originParam);
      }
    }

    // Filtro por Revendedor Específico
    if (resellerIdParam && resellerIdParam !== "all") {
      customersList = customersList.filter((c: any) => c.reseller_id === resellerIdParam);
    }

    // Filtro por Status
    if (statusParam && statusParam !== "all") {
      customersList = customersList.filter((c: any) => c.status === statusParam);
    }

    // Filtro por Plano
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

    // Ordenação (mais recentes primeiro)
    customersList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Métricas
    const totalItems = customersList.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const paginatedList = customersList.slice((page - 1) * limit, page * limit);

    const activeCount = customersList.filter((c: any) => c.status === "active").length;
    const directCount = customersList.filter((c: any) => c.origin === "NekoAI Admin").length;
    const resellerCount = customersList.filter((c: any) => c.origin === "Revendedor").length;

    return json({
      ok: true,
      customers: paginatedList,
      pagination: {
        page,
        limit,
        total_items: totalItems,
        total_pages: totalPages,
      },
      stats: {
        total_customers: totalItems,
        active_customers: activeCount,
        direct_customers: directCount,
        reseller_customers: resellerCount,
      },
    });
  }

  // ============================================================================
  // POST: AÇÕES DE CLIENTE (ATIVAR REVENDA, DESATIVAR REVENDA)
  // ============================================================================
  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, message: "JSON inválido." }, 400);
    }

    const { action, email, name, phone } = body;
    if (!email || !email.includes("@")) {
      return json({ ok: false, message: "E-mail do cliente é obrigatório e deve ser válido." }, 400);
    }

    const cleanEmail = email.trim().toLowerCase();

    // Bloquear criação/ativação com perfil administrativo
    if (cleanEmail.includes("admin@nekoai.com")) {
      return json({ ok: false, message: "Contas administrativas não podem ser convertidas em revendedores." }, 400);
    }

    // --------------------------------------------------------------------------
    // AÇÃO: ATIVAR REVENDA
    // --------------------------------------------------------------------------
    if (action === "activate_resale") {
      // 1. Verificar se já existe registro na tabela public.resellers
      const { data: existingReseller } = await supabaseAdmin
        .from("resellers")
        .select("*")
        .eq("email", cleanEmail)
        .maybeSingle();

      const targetRedirect = Deno.env.get("RESELLER_AUTH_REDIRECT_URL") || 
                             "https://nekoai-admin.vercel.app/recuperar-senha";

      // CASO A: Revendedor já existe (Reativação segura de revenda)
      if (existingReseller) {
        // Atualizar status para active
        const { error: updateErr } = await supabaseAdmin
          .from("resellers")
          .update({
            status: "active",
            name: (name && name.trim()) || existingReseller.name,
            phone: phone ? phone.trim() : existingReseller.phone,
            updated_at: new Date().toISOString()
          })
          .eq("id", existingReseller.id);

        if (updateErr) {
          return json({ ok: false, message: `Erro ao reativar revendedor: ${updateErr.message}` }, 500);
        }

        // Remover ban no auth.users
        if (existingReseller.user_id) {
          await supabaseAdmin.auth.admin.updateUserById(existingReseller.user_id, {
            ban_duration: "none"
          });
        }

        // Garantir preços configurados (preservando configurações personalizadas existentes)
        const { data: existingPrices } = await supabaseAdmin
          .from("reseller_price_settings")
          .select("id")
          .eq("reseller_id", existingReseller.id);

        if (!existingPrices || existingPrices.length === 0) {
          const officialPricing = await getOfficialPricing(supabaseAdmin);
          const upsertRows = (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map(plan => ({
            reseller_id: existingReseller.id,
            plan,
            neko_cost: officialPricing[plan].neko_cost,
            resale_price: officialPricing[plan].suggested_resale_price,
          }));
          await supabaseAdmin.from("reseller_price_settings").upsert(upsertRows);
        }

        // Gerar link de acesso/recuperação
        const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email: cleanEmail,
          options: {
            redirectTo: targetRedirect,
          }
        });

        let emailSent = false;
        if (!linkErr && linkData?.properties?.action_link) {
          const emailRes = await emailClient.sendRecoveryEmail(cleanEmail, linkData.properties.action_link);
          emailSent = emailRes.ok;
        }

        return json({
          ok: true,
          message: emailSent 
            ? "Acesso de revenda reativado com sucesso. E-mail com instruções enviado ao cliente." 
            : "Acesso de revenda reativado, mas houve falha no envio do e-mail via Resend.",
          reseller_id: existingReseller.id,
          status: "active"
        });
      }

      // CASO B: Revendedor nunca existiu (Criação reutilizando usuário de Auth se existente)
      let targetUserId: string | null = null;

      // 1. Procurar no auth.users primeiro
      const { data: usersData } = await supabaseAdmin.auth.admin.listUsers();
      if (usersData?.users) {
        const foundUser = usersData.users.find((u: any) => u.email?.toLowerCase() === cleanEmail);
        if (foundUser) {
          targetUserId = foundUser.id;
        }
      }

      // 2. Se não existir no auth, criar novo usuário
      if (!targetUserId) {
        const { data: newUser, error: createAuthErr } = await supabaseAdmin.auth.admin.createUser({
          email: cleanEmail,
          email_confirm: true,
          password: crypto.randomUUID(),
          user_metadata: { role: "reseller", name: (name && name.trim()) || cleanEmail }
        });

        if (createAuthErr) {
          // Se o usuário já existir no Auth (ex: listUsers paginado além da página 1), resolve targetUserId
          if (createAuthErr.message?.toLowerCase().includes("already") || (createAuthErr as any).status === 422) {
            let page = 1;
            while (!targetUserId && page <= 10) {
              const { data: pagedUsers } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
              if (!pagedUsers?.users || pagedUsers.users.length === 0) break;
              const matched = pagedUsers.users.find((u: any) => u.email?.toLowerCase() === cleanEmail);
              if (matched) {
                targetUserId = matched.id;
                break;
              }
              page++;
            }
          }

          if (!targetUserId) {
            return json({ ok: false, message: `Erro ao criar usuário de autenticação: ${createAuthErr.message}` }, 500);
          }
        } else if (newUser?.user) {
          targetUserId = newUser.user.id;
        }
      }

      // 3. Inserir em public.resellers
      const { data: createdReseller, error: insertErr } = await supabaseAdmin
        .from("resellers")
        .insert({
          user_id: targetUserId,
          name: (name && name.trim()) || cleanEmail,
          email: cleanEmail,
          phone: phone ? phone.trim() : null,
          status: "active"
        })
        .select()
        .single();

      if (insertErr || !createdReseller) {
        return json({ ok: false, message: `Erro ao cadastrar revendedor: ${insertErr?.message}` }, 500);
      }

      // 4. Inserir configurações de preço padrão resolvidas dinamicamente
      const officialPricing = await getOfficialPricing(supabaseAdmin);
      const upsertRows = (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map(plan => ({
        reseller_id: createdReseller.id,
        plan,
        neko_cost: officialPricing[plan].neko_cost,
        resale_price: officialPricing[plan].suggested_resale_price,
      }));
      await supabaseAdmin.from("reseller_price_settings").upsert(upsertRows);

      // 5. Gerar link e disparar e-mail via Resend
      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email: cleanEmail,
        options: {
          redirectTo: targetRedirect,
        }
      });

      let emailSent = false;
      if (!linkErr && linkData?.properties?.action_link) {
        const emailRes = await emailClient.sendRecoveryEmail(cleanEmail, linkData.properties.action_link);
        emailSent = emailRes.ok;
      }

      return json({
        ok: true,
        message: emailSent
          ? "Revenda ativada com sucesso. E-mail de acesso enviado ao cliente."
          : "Revenda criada, mas houve falha ao despachar o e-mail de acesso.",
        reseller_id: createdReseller.id,
        status: "active"
      });
    }

    // --------------------------------------------------------------------------
    // AÇÃO: DESATIVAR REVENDA
    // --------------------------------------------------------------------------
    if (action === "deactivate_resale") {
      const { data: currentReseller } = await supabaseAdmin
        .from("resellers")
        .select("id, user_id, status")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (!currentReseller) {
        return json({ ok: false, message: "Este cliente não possui revenda cadastrada." }, 404);
      }

      // 1. Atualizar status na tabela resellers para 'inactive'
      const { error: updateErr } = await supabaseAdmin
        .from("resellers")
        .update({
          status: "inactive",
          updated_at: new Date().toISOString()
        })
        .eq("id", currentReseller.id);

      if (updateErr) {
        return json({ ok: false, message: `Erro ao desativar revenda: ${updateErr.message}` }, 500);
      }

      // 2. Suspender autenticação no auth.users
      if (currentReseller.user_id) {
        await supabaseAdmin.auth.admin.updateUserById(currentReseller.user_id, {
          ban_duration: "87600h"
        });
      }

      return json({
        ok: true,
        message: "Revenda desativada com sucesso. O histórico e as licenças do cliente foram preservados.",
        status: "inactive"
      });
    }

    return json({ ok: false, message: "Ação não suportada." }, 400);
  }

  return json({ ok: false, message: "Método HTTP não suportado." }, 405);
  } catch (err: any) {
    return json({ ok: false, message: err?.message || "Erro interno." }, 500);
  }
});
