// supabase/functions/reseller-api/index.ts
// Edge Function restrita para Operações Comerciais e Checkout PIX de Revendedores

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    const payloadJson = base64UrlToString(b64Payload);
    const payload = JSON.parse(payloadJson);
    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== "number" || payload.exp < now) {
      return { valid: false, reason: "Token expirado" };
    }
    if (payload.role !== "neko_admin") {
      return { valid: false, reason: "Role incorreta" };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: err.message };
  }
}

function extractIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
         req.headers.get("cf-connecting-ip") ||
         req.headers.get("x-real-ip") ||
         "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");
  const mpAccessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[reseller-api] Erro: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes.");
    return json({ ok: false, error_code: "INTERNAL_ERROR", message: "Erro de configuração no servidor." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  // 1. Validação de Autenticação (Supabase Auth User JWT ou NekoAI Admin Token)
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
  let isAdmin = false;

  // Tentativa A: Supabase Auth User JWT
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

  // Tentativa B: NekoAI Admin Session Token (Admin logado via secret key)
  if (!reseller && !isAuthUser && adminSecret) {
    const adminCheck = await verifyAdminToken(authHeader, adminSecret.trim());
    if (adminCheck.valid) {
      isAdmin = true;
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
        const { data: anyReseller } = await supabaseAdmin
          .from("resellers")
          .select("id, name, email, phone, status")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (anyReseller) {
          reseller = anyReseller;
        } else {
          // Perfil de sistema administrativo para acesso à plataforma
          reseller = {
            id: "00000000-0000-0000-0000-000000000000",
            name: "NekoAI Admin",
            email: "admin@nekoai.com",
            status: "active",
          };
        }
      }
    }
  }

  // Se o usuário foi autenticado pelo Supabase Auth mas não possui perfil de revendedor -> 403
  if (isAuthUser && !reseller) {
    return json({ ok: false, error_code: "FORBIDDEN", message: "Você não possui permissão para acessar esta área." }, 403);
  }

  // Se não foi autenticado nem como usuário nem como admin -> 401
  if (!reseller) {
    console.warn(`[reseller-api] Autenticação rejeitada para IP ${extractIp(req)}: Nenhuma sessão válida de revendedor ou admin identificada.`);
    return json({ ok: false, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." }, 401);
  }

  if (reseller.status !== "active") {
    return json({ ok: false, error_code: "RESELLER_INACTIVE", message: "Você não possui permissão para acessar esta área." }, 403);
  }

  const url = new URL(req.url);

  // ============================================================================
  // GET: CONSULTA DE DETALHES DE UMA VENDA OU PREÇOS
  // ============================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action");

    if (action === "get_sale") {
      const saleId = url.searchParams.get("sale_id");
      if (!saleId) return json({ ok: false, message: "sale_id obrigatório." }, 400);

      const { data: sale, error: saleErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("id", saleId)
        .eq("reseller_id", reseller.id)
        .single();

      if (saleErr || !sale) return json({ ok: false, message: "Venda não encontrada." }, 404);
      return json({ ok: true, sale });
    }

    if (action === "list_sales") {
      const { data: sales, error: salesErr } = await supabaseAdmin
        .from("reseller_sales")
        .select("*")
        .eq("reseller_id", reseller.id)
        .order("created_at", { ascending: false });

      if (salesErr) return json({ ok: false, message: salesErr.message }, 500);
      return json({ ok: true, sales: sales || [] });
    }

    if (action === "get_price_settings") {
      const targetResellerId = (isAdmin && url.searchParams.get("reseller_id")) || reseller.id;
      let settings: any[] | null = null;
      if (targetResellerId && targetResellerId !== "00000000-0000-0000-0000-000000000000") {
        const { data } = await supabaseAdmin
          .from("reseller_price_settings")
          .select("plan, neko_cost, resale_price")
          .eq("reseller_id", targetResellerId);
        settings = data;
      }

      const existingMap: Record<string, number> = {};
      if (settings) {
        for (const s of settings) {
          existingMap[s.plan] = Number(s.resale_price);
        }
      }

      const result = (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map((plan) => {
        const nekoCost = OFFICIAL_NEKO_COSTS[plan];
        const resalePrice = existingMap[plan] ?? DEFAULT_RESALE_PRICES[plan];
        return {
          plan,
          neko_cost: nekoCost,
          resale_price: resalePrice,
          profit: Number((resalePrice - nekoCost).toFixed(2)),
        };
      });

      return json({ ok: true, settings: result });
    }

    return json({ ok: false, message: "Ação GET não suportada." }, 400);
  }

  // ============================================================================
  // POST: CRIAR INTENÇÃO DE COMPRA E GERAR COBRANÇA PIX (MERCADO PAGO)
  // ============================================================================
  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, message: "JSON inválido." }, 400);
    }

    if (body.action === "create_checkout") {
      const { plan, customer_name, customer_email, customer_whatsapp } = body;

      if (!plan || !["MONTHLY", "QUARTERLY", "ANNUAL"].includes(plan)) {
        return json({ ok: false, error_code: "INVALID_PLAN", message: "Plano inválido. Selecione MONTHLY, QUARTERLY ou ANNUAL." }, 400);
      }

      // 1. Custo Oficial NekoAI (Decidido no Servidor)
      const officialNekoCost = OFFICIAL_NEKO_COSTS[plan];

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

      if (existingPendingSale && existingPendingSale.pix_qr_code) {
        console.log(`[reseller-api] Reutilizando cobrança PIX pendente ativa (sale_id: ${existingPendingSale.id})`);
        return json({
          ok: true,
          reused: true,
          sale_id: existingPendingSale.id,
          plan: existingPendingSale.plan,
          neko_cost: existingPendingSale.neko_cost_snapshot,
          resale_price: existingPendingSale.resale_price_snapshot,
          profit: existingPendingSale.profit_snapshot,
          pix_qr_code: existingPendingSale.pix_qr_code,
          pix_qr_code_base64: existingPendingSale.pix_qr_code_base64,
          expires_at: existingPendingSale.expires_at,
          message: "Cobrança PIX pendente localizada. Exibindo QR Code existente.",
        });
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

      // 6. Comunicação com a API do Mercado Pago (Criação de Pagamento PIX Nativo)
      let mpPaymentId: string | null = null;
      let pixQrCode: string | null = null;
      let pixQrCodeBase64: string | null = null;

      if (mpAccessToken) {
        try {
          const mpResponse = await fetch("https://api.mercadopago.com/v1/payments", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${mpAccessToken.trim()}`,
              "X-Idempotency-Key": newSale.id,
            },
            body: JSON.stringify({
              transaction_amount: officialNekoCost, // O PIX é estritamente no valor do custo NekoAI
              description: `Licenca NekoAI - Plano ${plan}`,
              payment_method_id: "pix",
              external_reference: newSale.id,
              payer: {
                email: reseller.email,
                first_name: reseller.name,
              },
              date_of_expiration: expiresAt,
            }),
          });

          const mpData = await mpResponse.json();

          if (mpResponse.ok && mpData.id) {
            mpPaymentId = String(mpData.id);
            pixQrCode = mpData.point_of_interaction?.transaction_data?.qr_code || null;
            pixQrCodeBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64 || null;
          } else {
            console.error("[reseller-api] Erro na resposta do Mercado Pago:", mpData);
          }
        } catch (mpErr) {
          console.error("[reseller-api] Exceção na chamada de API Mercado Pago:", mpErr);
        }
      } else {
        console.warn("[reseller-api] MERCADOPAGO_ACCESS_TOKEN não configurado nas variáveis de ambiente. Simulação local ativada.");
        // Em ambiente dev sem token MP, gera simulação de PIX para testes unitários / integração
        mpPaymentId = `sim_mp_${Date.now()}`;
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
        mp_payment_id: mpPaymentId,
        pix_qr_code: pixQrCode,
        pix_qr_code_base64: pixQrCodeBase64,
        expires_at: expiresAt,
      });
    }

    if (body.action === "save_price_settings") {
      const { prices } = body;
      if (!prices || typeof prices !== "object") {
        return json({ ok: false, message: "Objeto 'prices' obrigatório." }, 400);
      }

      let targetResellerId = (isAdmin && body.reseller_id) || reseller.id;

      // Se for Admin e o targetResellerId for o ID sintético (00000000-0000-0000-0000-000000000000),
      // assegura a existência de um registro em resellers no banco para satisfazer a foreign key
      if (isAdmin && targetResellerId === "00000000-0000-0000-0000-000000000000") {
        try {
          const { data: usersData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
          let targetUserId = usersData?.users?.[0]?.id;
          if (!targetUserId) {
            const { data: newUser } = await supabaseAdmin.auth.admin.createUser({
              email: "admin@nekoai.com",
              email_confirm: true,
            });
            targetUserId = newUser?.user?.id;
          }
          if (targetUserId) {
            const { data: createdReseller } = await supabaseAdmin
              .from("resellers")
              .insert({
                user_id: targetUserId,
                name: "NekoAI Admin",
                email: "admin@nekoai.com",
                status: "active",
              })
              .select("id, name, email, phone, status")
              .maybeSingle();

            if (createdReseller) {
              targetResellerId = createdReseller.id;
              reseller = createdReseller;
            }
          }
        } catch (bootstrapErr) {
          console.warn("[reseller-api] Aviso ao assegurar perfil de revendedor para admin:", bootstrapErr);
        }
      }

      const upsertRows = [];
      const updatedSettings = [];

      for (const plan of ["MONTHLY", "QUARTERLY", "ANNUAL"] as const) {
        const officialNekoCost = OFFICIAL_NEKO_COSTS[plan];
        const rawVal = prices[plan];
        const resalePrice = typeof rawVal === "number" ? rawVal : parseFloat(rawVal);

        if (Number.isNaN(resalePrice) || resalePrice < officialNekoCost) {
          return json({
            ok: false,
            error_code: "INVALID_PRICE",
            message: `O preço do plano ${plan} (R$${prices[plan]}) não pode ser menor que o custo NekoAI (R$${officialNekoCost}).`,
          }, 400);
        }

        upsertRows.push({
          reseller_id: targetResellerId,
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

    return json({ ok: false, message: "Ação POST desconhecida." }, 400);
  }

  return json({ ok: false, message: "Método não suportado." }, 405);
});
