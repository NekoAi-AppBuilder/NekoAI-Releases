// supabase/functions/admin-resellers/index.ts
// Edge Function administrativa de gerenciamento de revendedores

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { emailClient } from "../_shared/email/email-client.ts";
import {
  getOfficialPricing,
  FALLBACK_ADMIN_PRICING,
} from "../_shared/pricing/admin-pricing.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    console.error("[admin-resellers] Configuração ausente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou NEKO_ADMIN_SECRET_KEY.");
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  // 1. Validação de Autorização Administrativa (case-insensitive)
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const authResult = await verifyAdminToken(authHeader, adminSecret);
  if (!authResult.valid) {
    console.warn(`[admin-resellers] Acesso negado: ${authResult.reason}`);
    return json({ ok: false, message: "Acesso administrativo não autorizado ou sessão expirada.", reason: authResult.reason }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  const adminIp = extractIp(req);
  const url = new URL(req.url);

  // ============================================================================
  // GET: LISTAGEM DE REVENDEDORES COM PAGINAÇÃO
  // ============================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action");

    if (action === "get_details") {
      const resellerId = url.searchParams.get("id");
      if (!resellerId) return json({ ok: false, message: "ID do revendedor ausente." }, 400);

      const { data: reseller, error } = await supabaseAdmin
        .from("resellers")
        .select("*")
        .eq("id", resellerId)
        .single();
      
      if (error || !reseller) return json({ ok: false, message: "Revendedor não encontrado." }, 404);

      // Buscar configurações de preço
      const { data: prices } = await supabaseAdmin
        .from("reseller_price_settings")
        .select("*")
        .eq("reseller_id", resellerId);

      // Metricas e Listas
      const { data: licensesData } = await supabaseAdmin
        .from("licenses")
        .select("*")
        .eq("reseller_id", resellerId)
        .neq("license_type", "TEST");
      
      const { data: salesData } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("reseller_id", resellerId)
        .order("created_at", { ascending: false });
      
      const validSales = (salesData || []).filter(s => s.status === "paid" || s.status === "license_delivered");
      const adminProfit = validSales.reduce((acc: number, curr: any) => acc + Number(curr.neko_cost_snapshot || 0), 0);
      const resellerProfit = validSales.reduce((acc: number, curr: any) => acc + Number(curr.profit_snapshot || 0), 0);

      const clientsMap = new Map();
      (licensesData || []).forEach(l => {
        if (!l.customer_email) return;
        const email = l.customer_email.toLowerCase();
        if (!clientsMap.has(email) || l.status === 'active') {
          clientsMap.set(email, l); // guardando a licença inteira para pegar os dados
        }
      });
      
      let activeClients = 0;
      let inactiveClients = 0;
      const clientsList: any[] = [];
      
      clientsMap.forEach((l) => {
        if (l.status === 'active') activeClients++;
        else inactiveClients++;
        
        clientsList.push({
          name: l.customer_name,
          email: l.customer_email,
          whatsapp: l.customer_whatsapp,
          status: l.status,
          plan: l.plan
        });
      });

      return json({ 
        ok: true, 
        reseller, 
        prices: prices || [],
        metrics: {
          admin_profit: adminProfit,
          reseller_profit: resellerProfit,
          active_clients: activeClients,
          inactive_clients: inactiveClients,
          sales: validSales.length,
          total_profit: resellerProfit // legacy field just in case
        },
        clientsList,
        salesHistory: salesData || []
      });
    }

    const search = url.searchParams.get("search")?.trim();
    const status = url.searchParams.get("status")?.trim().toLowerCase();
    const pageStr = url.searchParams.get("page");
    const limitStr = url.searchParams.get("limit");

    const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
    const limit = limitStr ? Math.max(1, Math.min(100, parseInt(limitStr, 10) || 20)) : 20;

    let query = supabaseAdmin
      .from("resellers")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    // Sanitize query by excluding Admin
    query = query.not("name", "ilike", "%admin%");

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
    }
    
    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);

    const { data: resellers, count: totalFilteredItems, error } = await query;
    
    if (error) return json({ ok: false, message: error.message }, 500);

    const totalItems = totalFilteredItems || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    // ==========================================
    // AGREGAR METRICAS (Lucro Admin, Lucro Revendedor, Clientes)
    // ==========================================
    let enrichedResellers = resellers || [];
    
    if (enrichedResellers.length > 0) {
      const resellerIds = enrichedResellers.map(r => r.id);
      
      const { data: salesData } = await supabaseAdmin
        .from("reseller_sales")
        .select("reseller_id, neko_cost_snapshot, profit_snapshot, status")
        .in("reseller_id", resellerIds)
        .in("status", ["paid", "license_delivered"]);
        
      const { data: licensesData } = await supabaseAdmin
        .from("licenses")
        .select("reseller_id, customer_email, status")
        .in("reseller_id", resellerIds)
        .neq("license_type", "TEST");

      enrichedResellers = enrichedResellers.map(r => {
        const rSales = salesData?.filter(s => s.reseller_id === r.id) || [];
        const rLicenses = licensesData?.filter(l => l.reseller_id === r.id) || [];
        
        const adminProfit = rSales.reduce((acc, curr) => acc + Number(curr.neko_cost_snapshot || 0), 0);
        const resellerProfit = rSales.reduce((acc, curr) => acc + Number(curr.profit_snapshot || 0), 0);
        
        const clientsMap = new Map();
        rLicenses.forEach(l => {
          if (!l.customer_email) return;
          const email = l.customer_email.toLowerCase();
          if (!clientsMap.has(email) || l.status === 'active') {
            clientsMap.set(email, l.status);
          }
        });
        
        let activeClients = 0;
        let inactiveClients = 0;
        clientsMap.forEach((status) => {
          if (status === 'active') activeClients++;
          else inactiveClients++;
        });
        
        return {
          ...r,
          metrics: {
            admin_profit: adminProfit,
            reseller_profit: resellerProfit,
            active_clients: activeClients,
            inactive_clients: inactiveClients
          }
        };
      });
    }

    // Stats gerais
    const { count: totalCount } = await supabaseAdmin.from("resellers").select("*", { count: "exact", head: true }).not("name", "ilike", "%admin%");
    const { count: activeCount } = await supabaseAdmin.from("resellers").select("*", { count: "exact", head: true }).eq("status", "active").not("name", "ilike", "%admin%");

    return json({
      ok: true,
      resellers: enrichedResellers,
      pagination: {
        page,
        limit,
        total_items: totalItems,
        total_pages: totalPages,
      },
      stats: {
        total_resellers: totalCount || 0,
        active_resellers: activeCount || 0,
      }
    });
  }

  // ============================================================================
  // POST: AÇÕES ADMINISTRATIVAS (CRIAR, ATUALIZAR STATUS)
  // ============================================================================
  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, message: "JSON inválido." }, 400);
    }

    if (body.action === "create") {
      const { name, email, phone } = body;
      
      if (!name || !name.trim()) return json({ ok: false, message: "Nome é obrigatório." }, 400);
      if (!email || !email.includes("@")) return json({ ok: false, message: "E-mail inválido." }, 400);

      // Verificar se admin
      if (name.toLowerCase().includes("admin") || email.toLowerCase().includes("admin")) {
        return json({ ok: false, message: "Contas administrativas não podem ser revendedores." }, 400);
      }

      // Check duplicidade no public.resellers primeiro
      const { data: existingReseller } = await supabaseAdmin
        .from("resellers")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      
      if (existingReseller) {
        return json({ ok: false, message: "Já existe um revendedor cadastrado com este e-mail." }, 409);
      }

      // Tenta achar ou criar usuário no auth.users
      const { data: usersData, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
      let targetUserId = null;

      if (!listErr && usersData?.users) {
        const existingUser = usersData.users.find((u: any) => u.email === email);
        if (existingUser) targetUserId = existingUser.id;
      }

      if (!targetUserId) {
        // Criar usuário no auth
        // O revendedor receberá as instruções por email para recuperar a senha / definir acesso.
        // Ou o Admin vai ter uma funcionalidade para enviar o link de reset.
        const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: true,
          password: crypto.randomUUID(), // Senha aleatória
          user_metadata: { role: "reseller", name }
        });

        if (createErr || !newUser?.user) {
          return json({ ok: false, message: `Erro ao criar usuário de autenticação: ${createErr?.message}` }, 500);
        }
        targetUserId = newUser.user.id;
      }

      // Inserir em resellers
      const { data: createdReseller, error: insertErr } = await supabaseAdmin
        .from("resellers")
        .insert({
          user_id: targetUserId,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone ? phone.trim() : null,
          status: "active"
        })
        .select()
        .single();
      
      if (insertErr) {
        return json({ ok: false, message: `Erro ao inserir revendedor: ${insertErr.message}` }, 500);
      }

      // Inserir configurações de preço padrão resolvidas dinamicamente
      const officialPricing = await getOfficialPricing(supabaseAdmin);
      const upsertRows = (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map(plan => ({
        reseller_id: createdReseller.id,
        plan,
        neko_cost: officialPricing[plan]?.neko_cost ?? OFFICIAL_NEKO_COSTS[plan],
        resale_price: officialPricing[plan]?.suggested_resale_price ?? DEFAULT_RESALE_PRICES[plan],
      }));

      await supabaseAdmin.from("reseller_price_settings").upsert(upsertRows);

      const targetRedirect = Deno.env.get("RESELLER_AUTH_REDIRECT_URL") || 
                             "https://nekoai-admin.vercel.app/recuperar-senha";

      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email: email.trim().toLowerCase(),
        options: {
          redirectTo: targetRedirect,
        }
      });

      let emailSentOk = false;
      if (!linkErr && linkData?.properties?.action_link) {
        const emailRes = await emailClient.sendRecoveryEmail(email.trim().toLowerCase(), linkData.properties.action_link);
        emailSentOk = emailRes.ok;
      }

      return json({ 
        ok: true, 
        reseller: createdReseller,
        message: !emailSentOk
          ? "Revendedor criado, mas houve falha ao disparar o e-mail de acesso via Resend."
          : "Revendedor criado com sucesso."
      });
    }

    if (body.action === "update_status") {
      const { reseller_id, status } = body;
      
      if (!reseller_id || !["active", "suspended", "inactive"].includes(status)) {
        return json({ ok: false, message: "Parâmetros inválidos." }, 400);
      }

      const { data: currentReseller, error: fetchErr } = await supabaseAdmin
        .from("resellers")
        .select("user_id, status")
        .eq("id", reseller_id)
        .single();

      if (fetchErr || !currentReseller) return json({ ok: false, message: "Revendedor não encontrado." }, 404);

      if (currentReseller.status !== status) {
        const banDuration = status === "active" ? "none" : "87600h";
        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(currentReseller.user_id, {
          ban_duration: banDuration
        });
        if (authErr) {
          console.error("Erro ao sincronizar ban no auth:", authErr);
        }
      }

      const { data: updated, error } = await supabaseAdmin
        .from("resellers")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", reseller_id)
        .select()
        .single();
      
      if (error) return json({ ok: false, message: error.message }, 500);

      return json({ ok: true, reseller: updated, message: `Status atualizado para ${status}.` });
    }
    
    if (body.action === "update_reseller") {
      const { reseller_id, name, email, phone } = body;
      
      if (!reseller_id || !name || !email) {
        return json({ ok: false, message: "ID, nome e e-mail são obrigatórios." }, 400);
      }

      const { data: currentReseller, error: fetchErr } = await supabaseAdmin
        .from("resellers")
        .select("user_id, email")
        .eq("id", reseller_id)
        .single();

      if (fetchErr || !currentReseller) return json({ ok: false, message: "Revendedor não encontrado." }, 404);

      // Sincronizar email no auth se tiver mudado
      if (currentReseller.email !== email.trim().toLowerCase()) {
        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(currentReseller.user_id, {
          email: email.trim().toLowerCase(),
        });
        
        if (authErr) {
          return json({ ok: false, message: `Erro ao atualizar e-mail no Auth: ${authErr.message}` }, 500);
        }
      }

      const { data: updated, error } = await supabaseAdmin
        .from("resellers")
        .update({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone ? phone.trim() : null,
          updated_at: new Date().toISOString()
        })
        .eq("id", reseller_id)
        .select()
        .single();
      
      if (error) return json({ ok: false, message: `Erro ao atualizar revendedor: ${error.message}` }, 500);

      return json({ ok: true, reseller: updated, message: "Revendedor atualizado com sucesso." });
    }
    
        if (body.action === "delete_reseller") {
      const { reseller_id } = body;
      if (!reseller_id) return json({ ok: false, message: "ID obrigatório." }, 400);

      // 1. Verificar se existem vendas com impacto financeiro real (historico que deve ser preservado)
      const { count: paidSalesCount } = await supabaseAdmin
        .from("reseller_sales")
        .select("*", { count: "exact", head: true })
        .eq("reseller_id", reseller_id)
        .in("status", ["paid", "awaiting_customer", "license_delivered"]);

      if (paidSalesCount && paidSalesCount > 0) {
        return json({ 
          ok: false, 
          message: "Não é possível excluir o revendedor pois existem vendas pagas vinculadas. Para preservar o histórico financeiro, revogue o acesso ao invés de excluir." 
        }, 400);
      }

      // 2. Limpar os registros "lixo" pendentes/cancelados que bloqueariam a FK (ON DELETE RESTRICT)
      // Clientes e licenças reais não são apagados, a FK de licenses (ON DELETE SET NULL) apenas desvincula o ID.
      await supabaseAdmin
        .from("reseller_sales")
        .delete()
        .eq("reseller_id", reseller_id)
        .in("status", ["pending", "expired", "cancelled"]);

      // 3. Agora podemos deletar com segurança o revendedor sem afetar o histórico real
      const { error } = await supabaseAdmin.from("resellers").delete().eq("id", reseller_id);

      if (error) return json({ ok: false, message: `Erro ao excluir: ${error.message}` }, 500);

      return json({ ok: true, message: "Revendedor excluído com sucesso." });
    }


    
    if (body.action === "resend_email") {
      const { email, redirect_to } = body;
      if (!email || !email.includes("@")) return json({ ok: false, message: "E-mail inválido ou obrigatório." }, 400);
      
      const targetRedirect = redirect_to || 
                             Deno.env.get("RESELLER_AUTH_REDIRECT_URL") || 
                             "https://nekoai-admin.vercel.app/recuperar-senha";

      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email: email.trim().toLowerCase(),
        options: {
          redirectTo: targetRedirect,
        }
      });
      
      if (linkErr || !linkData?.properties?.action_link) {
        console.error(`[admin-resellers] Erro ao gerar link de recuperação para ${email}:`, linkErr);
        return json({ ok: false, message: "Falha ao preparar o acesso do revendedor." }, 500);
      }

      const emailRes = await emailClient.sendRecoveryEmail(email.trim().toLowerCase(), linkData.properties.action_link);
      
      if (!emailRes.ok) {
        return json({ ok: false, message: "Falha ao despachar o e-mail pelo provedor." }, 500);
      }
      
      return json({ ok: true, message: "E-mail de redefinição de acesso enviado com sucesso." });
    }

    return json({ ok: false, message: "Ação desconhecida." }, 400);
  }

  return json({ ok: false, message: "Método não suportado." }, 405);
});
