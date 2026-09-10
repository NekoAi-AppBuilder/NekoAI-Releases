// supabase/functions/admin-licenses/index.ts
// Edge Function administrativa de gerenciamento de licenças (Multi-Dispositivo + Gestão de Clientes)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { emailClient } from "../_shared/email/email-client.ts";
import { encryptLicenseKey, decryptLicenseKey } from "../_shared/license-crypto.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    console.error("[admin-licenses] Configuração ausente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou NEKO_ADMIN_SECRET_KEY.");
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  // 1. Validação de Autorização Administrativa (case-insensitive)
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const authResult = await verifyAdminToken(authHeader, adminSecret);
  if (!authResult.valid) {
    console.warn(`[admin-licenses] Acesso negado: ${authResult.reason}`);
    return json({ ok: false, message: "Acesso administrativo não autorizado ou sessão expirada.", reason: authResult.reason }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  const adminIp = extractIp(req);
  const userAgent = req.headers.get("user-agent") || "NekoAI Admin Portal";
  const url = new URL(req.url);

  // ============================================================================
  // GET: LISTAGEM OU HISTÓRICO DE EVENTOS
  // ============================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action");

    if (action === "events") {
      const licenseId = url.searchParams.get("license_id");
      if (!licenseId) return json({ ok: false, message: "license_id ausente." }, 400);

      const { data: events, error: evError } = await supabaseAdmin
        .from("license_events")
        .select("*")
        .eq("license_id", licenseId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (evError) return json({ ok: false, message: evError.message }, 500);
      return json({ ok: true, events: events || [] });
    }

    const search = url.searchParams.get("search")?.trim().toUpperCase();
    const status = url.searchParams.get("status")?.trim().toLowerCase();
    const plan = url.searchParams.get("plan")?.trim().toUpperCase();

    // 1. Busca licenças com campos de cliente
    let query = supabaseAdmin
      .from("licenses")
      .select("id, key_mask, plan, status, max_devices, expires_at, entitlements, customer_name, customer_email, customer_whatsapp, created_at, updated_at, encrypted_key, license_type")
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(`key_mask.ilike.%${search}%,customer_name.ilike.%${search}%,customer_email.ilike.%${search}%,customer_whatsapp.ilike.%${search}%`);
    }
    if (status && status !== "all") query = query.eq("status", status);
    if (plan && plan !== "all") query = query.eq("plan", plan);

    const { data: licenseList, error: licError } = await query;
    if (licError) return json({ ok: false, message: licError.message }, 500);

    // 2. Busca ativações diretamente da tabela license_activations (Multi-Device)
    const licenseIds = (licenseList || []).map((l: any) => l.id);
    const activationsMap = new Map<string, Array<{ device_id: string; device_name: string; last_validated_at: string }>>();

    if (licenseIds.length > 0) {
      const { data: activations, error: actError } = await supabaseAdmin
        .from("license_activations")
        .select("license_id, device_id, device_name, last_validated_at")
        .in("license_id", licenseIds)
        .order("created_at", { ascending: true });

      if (actError) {
        console.error("[admin-licenses] Erro ao buscar license_activations:", actError);
      } else if (activations) {
        for (const act of activations) {
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

    // 3. Contadores globais
    const { count: totalCount } = await supabaseAdmin.from("licenses").select("*", { count: "exact", head: true });
    const { count: activeCount } = await supabaseAdmin.from("licenses").select("*", { count: "exact", head: true }).eq("status", "active");
    const { count: revokedCount } = await supabaseAdmin.from("licenses").select("*", { count: "exact", head: true }).eq("status", "revoked");
    const { count: expiredCount } = await supabaseAdmin.from("licenses").select("*", { count: "exact", head: true }).eq("status", "expired");
    const { count: activeDevicesCount } = await supabaseAdmin.from("license_activations").select("*", { count: "exact", head: true });

    const formatted = (licenseList || []).map((lic: any) => {
      const activeDevices = activationsMap.get(lic.id) || [];
      return {
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
        has_stored_key: !!(lic.encrypted_key && lic.encrypted_key.length > 0),
        license_type: lic.license_type || "NORMAL",
        created_at: lic.created_at,
        updated_at: lic.updated_at,
        active_devices: activeDevices,
        active_devices_count: activeDevices.length,
        // Compatibilidade retroativa
        active_device: activeDevices.length > 0 ? activeDevices[0] : null,
      };
    });

    return json({
      ok: true,
      licenses: formatted,
      stats: {
        total_licenses: totalCount || 0,
        active_licenses: activeCount || 0,
        revoked_licenses: revokedCount || 0,
        expired_licenses: expiredCount || 0,
        active_devices: activeDevicesCount || 0,
      },
    });
  }

  // ============================================================================
  // POST: AÇÕES ADMINISTRATIVAS (CRIAR, ATUALIZAR, STATUS, REMOVER DISPOSITIVO)
  // ============================================================================
  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, message: "JSON inválido." }, 400);
    }

    // Ação 1: Criar Nova Licença (com suporte a cliente e max_devices)
    if (body.action === "create") {
      const { key_hash, key_mask, plan, expires_at, max_devices, customer_name, customer_email, customer_whatsapp } = body;

      if (!key_hash || !/^[0-9a-fA-F]{64}$/.test(key_hash)) return json({ ok: false, message: "Hash SHA-256 da chave inválido." }, 400);
      const isTestKey = /^NEKO-TEST-\*{4}-\*{4}-\*{4}$/.test(key_mask);
      const isLegacyTestKey = /^NEKO-TEST-\*{3}-\*{3}-\*{3}$/.test(key_mask);
      if (!isTestKey && !isLegacyTestKey && !/^NEKO-\*{4}-\*{4}-\*{4}-[A-Z0-9]{4}$/.test(key_mask)) return json({ ok: false, message: "Máscara de chave inválida." }, 400);
      if (!["MONTHLY", "QUARTERLY", "ANNUAL"].includes(plan)) return json({ ok: false, message: "Plano inválido." }, 400);

      const licenseType: "NORMAL" | "TEST" = body.license_type === "TEST" ? "TEST" : "NORMAL";

      const targetMaxDevices = Number.isInteger(max_devices) && max_devices >= 1 ? max_devices : 1;
      const defaultEntitlements = ["agent_execution", "preview_server", "file_manipulation", "cloud_supabase", "cloud_github", "cloud_vercel"];

      let encryptedKey: string | null = null;
      if (body.plain_key) {
        try {
          encryptedKey = await encryptLicenseKey(body.plain_key, adminSecret);
        } catch (encErr) {
          console.warn("[admin-licenses] Falha ao criptografar chave da licença:", encErr);
        }
      }

      const { data: newLic, error: insertError } = await supabaseAdmin
        .from("licenses")
        .insert({
          user_id: null,
          key_hash,
          key_mask,
          plan,
          license_type: licenseType,
          status: "active",
          max_devices: targetMaxDevices,
          customer_name: typeof customer_name === "string" ? customer_name.trim().slice(0, 128) : null,
          customer_email: typeof customer_email === "string" ? customer_email.trim().slice(0, 255) : null,
          customer_whatsapp: typeof customer_whatsapp === "string" ? customer_whatsapp.trim().slice(0, 32) : null,
          expires_at: expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          entitlements: body.entitlements || defaultEntitlements,
          encrypted_key: encryptedKey,
        })
        .select()
        .single();

      if (insertError) return json({ ok: false, message: insertError.message }, 500);

      await supabaseAdmin.from("license_events").insert({
        license_id: newLic.id,
        device_id: "00000000000000000000000000000000",
        event_type: "activate",
        ip_address: adminIp !== "unknown" ? adminIp : null,
        user_agent: userAgent,
        metadata: {
          admin_action: "create_license",
          plan,
          key_mask,
          max_devices: targetMaxDevices,
          customer_name: newLic.customer_name,
          customer_email: newLic.customer_email,
        },
      });

      // Se fornecido plain_key e customer_email, e send_email for verdadeiro, envia o e-mail
      let emailResult = null;
      if (body.plain_key && newLic.customer_email && body.send_email !== false) {
        try {
          emailResult = await emailClient.sendLicenseDelivery({
            customerName: newLic.customer_name,
            customerEmail: newLic.customer_email,
            licenseKey: body.plain_key.trim().toUpperCase(),
            plan: newLic.plan,
            maxDevices: targetMaxDevices,
            license_type: licenseType,
            test_duration_label: body.test_duration_label,
            test_expires_at: expires_at,
          });

          await supabaseAdmin.from("license_events").insert({
            license_id: newLic.id,
            device_id: "00000000000000000000000000000000",
            event_type: emailResult.ok ? "validate" : "failed_attempt",
            ip_address: adminIp !== "unknown" ? adminIp : null,
            user_agent: userAgent,
            metadata: {
              admin_action: "send_license_email",
              customer_email: newLic.customer_email,
              email_id: emailResult.email_id || null,
              error_code: emailResult.error_code || null,
            },
          });
        } catch (err: any) {
          console.error("[admin-licenses] Erro ao enviar e-mail de licença:", err);
        }
      }

      return json({ ok: true, license: newLic, email_delivery: emailResult });
    }

    // Ação: Enviar / Reenviar E-mail de Licença com Chave Completa (Sem Máscara)
    if (body.action === "send_license_email") {
      const { license_id, plain_key, customer_email, customer_name } = body;

      let targetEmail = customer_email;
      let targetName = customer_name;
      let targetPlan: any = "MONTHLY";
      let targetDevices = 1;
      let targetKey = "";

      let lic: any = null;
      if (license_id) {
        const { data: fetchedLic, error: fetchErr } = await supabaseAdmin
          .from("licenses")
          .select("*")
          .eq("id", license_id)
          .single();

        if (fetchErr || !fetchedLic) {
          return json({ ok: false, message: "Licença não encontrada." }, 404);
        }
        lic = fetchedLic;
        targetEmail = targetEmail || lic.customer_email;
        targetName = targetName || lic.customer_name;
        targetPlan = lic.plan || "MONTHLY";
        targetDevices = lic.max_devices || 1;
      }

      // Determinar license_type a partir do registro (NORMAL para legado)
      const licType: "NORMAL" | "TEST" = lic?.license_type === "TEST" ? "TEST" : "NORMAL";

      // Calcular duração do teste para o template
      let testDurationLabel: string | undefined;
      let testExpiresAt: string | undefined;
      if (licType === "TEST" && lic?.expires_at) {
        testExpiresAt = lic.expires_at;
        const nowMs = Date.now();
        const expiresMs = new Date(lic.expires_at).getTime();
        const diffMs = expiresMs - nowMs;
        if (diffMs <= 0) {
          testDurationLabel = "Expirado";
        } else if (diffMs <= 60 * 60 * 1000) {
          testDurationLabel = "1 hora";
        } else if (diffMs <= 6 * 60 * 60 * 1000) {
          testDurationLabel = "6 horas";
        } else if (diffMs <= 12 * 60 * 60 * 1000) {
          testDurationLabel = "12 horas";
        } else if (diffMs <= 24 * 60 * 60 * 1000) {
          testDurationLabel = "24 horas";
        } else if (diffMs <= 3 * 24 * 60 * 60 * 1000) {
          testDurationLabel = "3 dias";
        } else {
          testDurationLabel = "7 dias";
        }
      }

      // 1. Prioridade: Se plain_key foi informado explicitamente pelo admin
        if (plain_key && typeof plain_key === "string" && plain_key.trim()) {
        const candidateKey = plain_key.trim().toUpperCase();
        const isValidNormalKey = /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(candidateKey);
        const isValidTestKey = /^NEKO-TEST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(candidateKey);
        const isLegacyTestKey = /^NEKO-TEST-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(candidateKey);
        if (isValidNormalKey || isValidTestKey || isLegacyTestKey) {
          targetKey = candidateKey;
          // Se o registro no banco não possuía encrypted_key, armazena para futuros reenvios automáticos
          if (lic && !lic.encrypted_key) {
            try {
              const encKey = await encryptLicenseKey(candidateKey, adminSecret);
              await supabaseAdmin.from("licenses").update({ encrypted_key: encKey }).eq("id", lic.id);
            } catch (err) {
              console.warn("[admin-licenses] Não foi possível persistir encrypted_key:", err);
            }
          }
        } else {
          return json({ ok: false, message: "Formato da chave de licença inválido (esperado: NEKO-XXXX-XXXX-XXXX-XXXX ou NEKO-TEST-XXXX-XXXX-XXXX)." }, 400);
        }
      }

      // 2. Se plain_key não veio no payload, tenta descriptografar a chave armazenada
      if (!targetKey && lic?.encrypted_key) {
        const decrypted = await decryptLicenseKey(lic.encrypted_key, adminSecret);
        const isValidNormal = decrypted && /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(decrypted);
        const isValidTest = decrypted && /^NEKO-TEST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(decrypted);
        const isLegacyTest = decrypted && /^NEKO-TEST-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(decrypted);
        if (isValidNormal || isValidTest || isLegacyTest) {
          targetKey = decrypted;
        }
      }

      // 3. Validação estrita: NUNCA enviar chave mascarada por e-mail
      const isValidNormalFinal = /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(targetKey);
      const isValidTestFinal = /^NEKO-TEST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(targetKey);
      const isLegacyTestFinal = /^NEKO-TEST-[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(targetKey);
      if (!targetKey || (!isValidNormalFinal && !isValidTestFinal && !isLegacyTestFinal)) {
        // Caso legado: chave completa não está armazenada no servidor
        if (lic && !lic.encrypted_key && (!plain_key || !plain_key.trim())) {
          return json({
            ok: false,
            message: "Esta licença não possui chave completa armazenada no servidor (criada antes da criptografia). Para reenviar, digite a chave de ativação completa no campo \"Chave da Licença\".",
            code: "LEGACY_KEY_MISSING",
          }, 400);
        }
        return json({
          ok: false,
          message: "A chave completa não está armazenada no servidor para esta licença legada. Por favor, digite a chave completa de ativação para reenviar.",
        }, 400);
      }

      if (!targetEmail || !targetEmail.includes("@")) {
        return json({ ok: false, message: "E-mail de destino ausente ou inválido." }, 400);
      }

      const emailResult = await emailClient.sendLicenseDelivery({
        customerName: targetName,
        customerEmail: targetEmail,
        licenseKey: targetKey,
        plan: targetPlan,
        maxDevices: targetDevices,
        license_type: licType,
        test_duration_label: testDurationLabel,
        test_expires_at: testExpiresAt,
      });

      if (license_id) {
        await supabaseAdmin.from("license_events").insert({
          license_id,
          device_id: "00000000000000000000000000000000",
          event_type: emailResult.ok ? "validate" : "failed_attempt",
          ip_address: adminIp !== "unknown" ? adminIp : null,
          user_agent: userAgent,
          metadata: {
            admin_action: "resend_license_email",
            customer_email: targetEmail,
            email_id: emailResult.email_id || null,
            error_code: emailResult.error_code || null,
          },
        });
      }

      return json({
        ok: emailResult.ok,
        email_id: emailResult.email_id,
        message: emailResult.ok ? "✓ E-mail enviado com sucesso com a chave de ativação completa." : "Não foi possível enviar o e-mail. Tente novamente.",
      }, emailResult.ok ? 200 : 400);
    }

    // Ação 2: Atualizar Dados da Licença e Cliente (update_license)
    if (body.action === "update_license") {
      const { license_id, customer_name, customer_email, customer_whatsapp, max_devices, plan, expires_at } = body;
      if (!license_id) return json({ ok: false, message: "license_id obrigatório." }, 400);

      // Busca estado anterior para auditoria e validação
      const { data: currentLic, error: fetchErr } = await supabaseAdmin
        .from("licenses")
        .select("*")
        .eq("id", license_id)
        .single();

      if (fetchErr || !currentLic) return json({ ok: false, message: "Licença não encontrada." }, 404);

      const updatePayload: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };

      if (typeof customer_name !== "undefined") updatePayload.customer_name = customer_name ? String(customer_name).trim().slice(0, 128) : null;
      if (typeof customer_email !== "undefined") updatePayload.customer_email = customer_email ? String(customer_email).trim().slice(0, 255) : null;
      if (typeof customer_whatsapp !== "undefined") updatePayload.customer_whatsapp = customer_whatsapp ? String(customer_whatsapp).trim().slice(0, 32) : null;
      if (plan && ["MONTHLY", "QUARTERLY", "ANNUAL"].includes(plan)) updatePayload.plan = plan;
      if (expires_at) updatePayload.expires_at = expires_at;

      if (typeof max_devices !== "undefined") {
        const numDevices = Number(max_devices);
        if (!Number.isInteger(numDevices) || numDevices < 1 || numDevices > 100) {
          return json({ ok: false, message: "Número de dispositivos deve ser entre 1 e 100." }, 400);
        }

        // Validação segura: se está reduzindo, verifica quantos estão ativos
        if (numDevices < currentLic.max_devices) {
          const { count: currentActive } = await supabaseAdmin
            .from("license_activations")
            .select("*", { count: "exact", head: true })
            .eq("license_id", license_id);

          if ((currentActive || 0) > numDevices) {
            return json({
              ok: false,
              message: `Não é possível reduzir para ${numDevices} dispositivos pois já existem ${currentActive} ativos. Desvincule os computadores excedentes primeiro.`,
            }, 400);
          }
        }
        updatePayload.max_devices = numDevices;
      }

      const { data: updatedLic, error: updateErr } = await supabaseAdmin
        .from("licenses")
        .update(updatePayload)
        .eq("id", license_id)
        .select()
        .single();

      if (updateErr) return json({ ok: false, message: updateErr.message }, 500);

      // Auditoria de alteração
      await supabaseAdmin.from("license_events").insert({
        license_id,
        device_id: "00000000000000000000000000000000",
        event_type: "activate",
        ip_address: adminIp !== "unknown" ? adminIp : null,
        user_agent: userAgent,
        metadata: {
          admin_action: "update_license",
          admin_ip: adminIp,
          changes: updatePayload,
          previous: {
            customer_name: currentLic.customer_name,
            customer_email: currentLic.customer_email,
            max_devices: currentLic.max_devices,
            plan: currentLic.plan,
            expires_at: currentLic.expires_at,
          },
        },
      });

      return json({ ok: true, license: updatedLic });
    }

    // Ação 3: Remover Dispositivo Específico (remove_device)
    if (body.action === "remove_device") {
      const { license_id, device_id, reason } = body;
      if (!license_id || !device_id) {
        return json({ ok: false, message: "license_id e device_id são obrigatórios." }, 400);
      }

      const { data: deleted, error: delError } = await supabaseAdmin
        .from("license_activations")
        .delete()
        .eq("license_id", license_id)
        .eq("device_id", device_id)
        .select();

      if (delError) return json({ ok: false, message: delError.message }, 500);

      const wasRemoved = deleted && deleted.length > 0;

      if (wasRemoved) {
        await supabaseAdmin.from("license_events").insert({
          license_id,
          device_id,
          event_type: "deactivate_device",
          ip_address: adminIp !== "unknown" ? adminIp : null,
          user_agent: userAgent,
          metadata: {
            admin_action: "remove_device",
            admin_ip: adminIp,
            removed_device_id: device_id,
            reason: reason || "Desvinculação manual pelo painel administrativo",
          },
        });
      }

      return json({ ok: true, removed: wasRemoved, message: wasRemoved ? "Dispositivo desvinculado com sucesso." : "Dispositivo não encontrado." });
    }

    // Ação 4: Alterar Status (Revogar / Reativar)
    if (body.action === "update_status") {
      const { license_id, status, reason } = body;
      if (!license_id || !["active", "revoked"].includes(status)) return json({ ok: false, message: "Parâmetros de status inválidos." }, 400);

      const { error: updateError } = await supabaseAdmin
        .from("licenses")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", license_id);

      if (updateError) return json({ ok: false, message: updateError.message }, 500);

      if (status === "revoked") {
        await supabaseAdmin.from("license_activations").delete().eq("license_id", license_id);
      }

      await supabaseAdmin.from("license_events").insert({
        license_id,
        device_id: "00000000000000000000000000000000",
        event_type: status === "revoked" ? "revoke" : "activate",
        ip_address: adminIp !== "unknown" ? adminIp : null,
        user_agent: userAgent,
        metadata: {
          admin_action: "update_status",
          new_status: status,
          admin_ip: adminIp,
          reason: reason || (status === "revoked" ? "Revogação administrativa manual" : "Reativação administrativa manual"),
        },
      });

      return json({ ok: true, message: `Status alterado para ${status} com sucesso.` });
    }

    // Ação 5: Excluir Licença (remove do gerenciamento ativo)
    if (body.action === "delete_license") {
      const { license_id } = body;
      if (!license_id) return json({ ok: false, message: "license_id obrigatório." }, 400);

      // Verificar se a licença existe antes de excluir
      const { data: existingLic, error: fetchErr } = await supabaseAdmin
        .from("licenses")
        .select("id, key_mask, customer_name, customer_email")
        .eq("id", license_id)
        .single();

      if (fetchErr || !existingLic) return json({ ok: false, message: "Licença não encontrada." }, 404);

      // Verificar se existem assinaturas de billing vinculadas (ON DELETE CASCADE protegeria, mas bloqueamos aqui)
      const { count: billingCount } = await supabaseAdmin
        .from("billing_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("license_id", license_id);

      if (billingCount && billingCount > 0) {
        return json({
          ok: false,
          message: "Esta licença possui dados de billing vinculados e não pode ser excluída. Remova ou cancele a assinatura associada antes de prosseguir.",
          code: "BILLING_LINKED",
        }, 400);
      }

      // Remover dispositivos vinculados
      await supabaseAdmin.from("license_activations").delete().eq("license_id", license_id);

      // Registrar evento de exclusão antes de remover (mantém trilha de auditoria)
      await supabaseAdmin.from("license_events").insert({
        license_id,
        device_id: "00000000000000000000000000000000",
        event_type: "revoke",
        ip_address: adminIp !== "unknown" ? adminIp : null,
        user_agent: userAgent,
        metadata: {
          admin_action: "delete_license",
          admin_ip: adminIp,
          key_mask: existingLic.key_mask,
          customer_name: existingLic.customer_name,
          customer_email: existingLic.customer_email,
        },
      });

      // Excluir a licença
      const { error: deleteErr } = await supabaseAdmin
        .from("licenses")
        .delete()
        .eq("id", license_id);

      if (deleteErr) return json({ ok: false, message: deleteErr.message }, 500);

      return json({ ok: true, message: "Licença excluída permanentemente." });
    }

    return json({ ok: false, message: "Ação desconhecida." }, 400);
  }

  return json({ ok: false, message: "Método não suportado." }, 405);
});
