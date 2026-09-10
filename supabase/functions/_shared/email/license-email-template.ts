// supabase/functions/_shared/email/license-email-template.ts
// Template oficial de e-mail de entrega de licença NekoAI inspirado na Landing Page oficial

export interface LicenseEmailData {
  customerName?: string | null;
  customerEmail: string;
  licenseKey: string;
  plan: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  maxDevices: number;
  downloadUrl?: string;
  supportUrl?: string;
  logoUrl?: string;
  license_type?: "NORMAL" | "TEST";
  test_duration_label?: string;
  test_expires_at?: string;
}

/**
 * URL pública oficial do logo do NekoAI específico para e-mail
 */
export const DEFAULT_NEKO_LOGO_URL = "https://nekoai.lovinfinity.com.br/Logo-NekoAI-email.png";

export function getPlanDisplayName(plan: "MONTHLY" | "QUARTERLY" | "ANNUAL"): string {
  switch (plan) {
    case "MONTHLY":
      return "Plano Mensal";
    case "QUARTERLY":
      return "Plano Trimestral";
    case "ANNUAL":
      return "Plano Anual";
    default:
      return "Assinatura NekoAI";
  }
}

export function getPlanValidityText(plan: "MONTHLY" | "QUARTERLY" | "ANNUAL"): string {
  switch (plan) {
    case "MONTHLY":
      return "Renovação a cada 30 dias";
    case "QUARTERLY":
      return "Renovação a cada 90 dias";
    case "ANNUAL":
      return "Acesso por 1 ano completo (365 dias)";
    default:
      return "Acesso Contínuo";
  }
}

export function generateLicenseEmailSubject(data: LicenseEmailData): string {
  if (data.license_type === "TEST") {
    return "Sua licença de teste NekoAI";
  }
  const planName = getPlanDisplayName(data.plan);
  return `Seu acesso ao NekoAI está pronto [${planName}]`;
}

export function generateLicenseEmailPlainText(data: LicenseEmailData): string {
  const greeting = data.customerName && data.customerName.trim()
    ? `Olá, ${data.customerName.trim()}!`
    : "Olá!";

  if (data.license_type === "TEST") {
    const devicesText = data.maxDevices === 1 ? "1 computador" : `${data.maxDevices} computadores`;
    const durationLabel = data.test_duration_label || "Período de teste";
    const expiresLine = data.test_expires_at
      ? `Expira em: ${new Date(data.test_expires_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "";
    const downloadUrl = data.downloadUrl || "https://nekoai.lovinfinity.com.br/download";
    const supportUrl = data.supportUrl || "https://wa.me/5511999999999";

    return `
NEKOAI — LICENÇA DE TESTE

Sua licença de teste do NekoAI foi criada com sucesso.

${greeting}

==================================================
SUA CHAVE DE ATIVAÇÃO:
${data.licenseKey}
==================================================

INFORMAÇÕES DA LICENÇA:
- TIPO: Licença de teste
- VALIDADE: ${durationLabel}
- DISPOSITIVOS: ${devicesText}
${expiresLine ? `- ${expiresLine}` : ""}

DOWNLOAD:
Baixe a versão mais recente do NekoAI para Windows e comece a testar:
${downloadUrl}

COMECE EM 3 PASSOS:
01 — BAIXE
Baixe o instalador do NekoAI para Windows.

02 — INSTALE
Instale e abra o NekoAI no seu computador.

03 — ATIVE
Cole sua chave de licença quando solicitado e comece a testar.

SUPORTE:
Precisa de ajuda?
Nossa equipe está pronta para ajudar você a começar:
${supportUrl}

--------------------------------------------------
NekoAI — App Builder
Este é um e-mail automático enviado com sua licença de teste.
`.trim();
  }

  const planName = getPlanDisplayName(data.plan);
  const validityText = getPlanValidityText(data.plan);
  const devicesText = data.maxDevices === 1 ? "1 computador" : `${data.maxDevices} computadores`;
  const downloadUrl = data.downloadUrl || "https://nekoai.lovinfinity.com.br/download";
  const supportUrl = data.supportUrl || "https://wa.me/5511999999999";

  return `
NEKOAI — LICENÇA DE ACESSO

Seu acesso ao NekoAI está pronto.

${greeting} Seu pagamento foi confirmado e sua licença já está disponível.

==================================================
SUA CHAVE DE ATIVAÇÃO:
${data.licenseKey}
==================================================
Copie sua chave para ativar o NekoAI no seu computador.

INFORMAÇÕES DA LICENÇA:
- PLANO: ${planName}
- DISPOSITIVOS: ${devicesText}
- VALIDADE: ${validityText}

DOWNLOAD:
Seu NekoAI está pronto.
Baixe a versão mais recente do NekoAI para Windows e comece a usar sua licença:
${downloadUrl}

COMECE EM 3 PASSOS:
01 — BAIXE
Baixe o instalador do NekoAI para Windows.

02 — INSTALE
Instale e abra o NekoAI no seu computador.

03 — ATIVE
Cole sua chave de licença quando solicitado e comece a usar.

SUPORTE:
Precisa de ajuda?
Nossa equipe está pronta para ajudar você a começar:
${supportUrl}

--------------------------------------------------
NekoAI — App Builder
Este é um e-mail automático enviado após a confirmação do seu pagamento.
`.trim();
}

export function generateLicenseEmailHtml(data: LicenseEmailData): string {
  const greetingName = data.customerName && data.customerName.trim()
    ? `, ${escapeHtml(data.customerName.trim())}`
    : "";
  const planName = getPlanDisplayName(data.plan);
  const validityText = getPlanValidityText(data.plan);
  const devicesText = data.maxDevices === 1 ? "1 computador" : `${data.maxDevices} computadores`;
  const downloadUrl = data.downloadUrl || "https://nekoai.lovinfinity.com.br/download";
  const supportUrl = data.supportUrl || "https://wa.me/5511999999999";
  const logoUrl = data.logoUrl || DEFAULT_NEKO_LOGO_URL;

  const isTest = data.license_type === "TEST";
  const testDurationLabel = data.test_duration_label || "Período de teste";
  const testExpiresFormatted = data.test_expires_at
    ? new Date(data.test_expires_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  const badgeLabel = isTest ? "LICENÇA DE TESTE" : "LICENÇA NEKOAI";
  const heroTitle = isTest
    ? `Sua licença de <span class="email-text-magenta" style="color: #e879f9 !important;">teste NekoAI</span> está pronta.`
    : `Seu acesso ao <span class="email-text-magenta" style="color: #e879f9 !important;">NekoAI</span> está pronto.`;
  const heroBody = isTest
    ? `Olá${greetingName}! Sua licença de teste do NekoAI foi criada com sucesso.`
    : `Olá${greetingName}! Seu pagamento foi confirmado e sua licença já está disponível.`;

  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Seu acesso ao NekoAI está pronto</title>
  <style type="text/css">
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; background-color: #030014 !important; color: #cbd5e1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    
    /* PREFERS COLOR SCHEME (APPLE MAIL / IOS / MODERN WEBMAIL) */
    @media (prefers-color-scheme: dark) {
      body, .email-bg-outer { background-color: #030014 !important; background: #030014 !important; }
      .email-bg-container { background-color: #07031c !important; background: #07031c !important; }
      .email-bg-card-license { background-color: #0c0521 !important; background: #0c0521 !important; }
      .email-bg-card-key { background-color: #14072b !important; }
      .email-bg-card-info { background-color: #0c0624 !important; background: #0c0624 !important; }
      .email-bg-card-steps { background-color: #0a041f !important; background: #0a041f !important; }
      .email-bg-card-support { background-color: #0d0624 !important; background: #0d0624 !important; }
      .email-bg-footer { background-color: #030014 !important; background: #030014 !important; }
      
      .email-text-title { color: #ffffff !important; }
      .email-text-body { color: #cbd5e1 !important; }
      .email-text-muted { color: #a1a1aa !important; }
      .email-text-cyan { color: #38bdf8 !important; }
      .email-text-purple { color: #c084fc !important; }
      .email-text-magenta { color: #d946ef !important; }
      .email-text-badge { color: #e9d5ff !important; }
    }
    
    /* OUTLOOK & OFFICE 365 DARK MODE SPECIFIC FIXES ([data-ogsb] / [data-ogsc]) */
    [data-ogsb] .email-bg-outer { background-color: #030014 !important; }
    [data-ogsb] .email-bg-container { background-color: #07031c !important; }
    [data-ogsb] .email-bg-header { background-color: #1e053a !important; }
    [data-ogsb] .email-bg-badge { background-color: #1b0933 !important; }
    [data-ogsb] .email-bg-card-license { background-color: #0c0521 !important; }
    [data-ogsb] .email-bg-card-key { background-color: #14072b !important; }
    [data-ogsb] .email-bg-card-info { background-color: #0c0624 !important; }
    [data-ogsb] .email-bg-btn-download { background-color: #8b5cf6 !important; }
    [data-ogsb] .email-bg-card-steps { background-color: #0a041f !important; }
    [data-ogsb] .email-bg-card-support { background-color: #0d0624 !important; }
    [data-ogsb] .email-bg-btn-support { background-color: #240b4a !important; }
    [data-ogsb] .email-bg-footer { background-color: #030014 !important; }
    
    [data-ogsc] .email-text-title { color: #ffffff !important; }
    [data-ogsc] .email-text-body { color: #cbd5e1 !important; }
    [data-ogsc] .email-text-muted { color: #a1a1aa !important; }
    [data-ogsc] .email-text-cyan { color: #38bdf8 !important; }
    [data-ogsc] .email-text-purple { color: #c084fc !important; }
    [data-ogsc] .email-text-magenta { color: #d946ef !important; }
    [data-ogsc] .email-text-badge { color: #e9d5ff !important; }
    [data-ogsc] .email-text-btn { color: #ffffff !important; }
    [data-ogsc] .email-text-btn-support { color: #e9d5ff !important; }

    @media only screen and (max-width: 600px) {
      .responsive-col { display: block !important; width: 100% !important; margin-bottom: 12px !important; }
      .responsive-spacer { display: none !important; }
      .container-padding { padding: 24px 20px !important; }
    }
  </style>
</head>
<body bgcolor="#030014" class="email-bg-outer" style="margin: 0; padding: 0; background-color: #030014 !important; color: #cbd5e1;">
  
  <!-- OUTER WRAPPER TABLE -->
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#030014" class="email-bg-outer" style="width: 100%; background-color: #030014 !important; margin: 0; padding: 40px 10px;">
    <tr>
      <td align="center" bgcolor="#030014" class="email-bg-outer" style="background-color: #030014 !important;">
        
        <!-- MAIN CONTAINER (CLEAN, BORDERLESS SAAS FLOW) -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#07031c" class="email-bg-container" style="max-width: 620px; margin: 0 auto; background-color: #07031c !important; border-radius: 24px; border: 1px solid rgba(124, 58, 237, 0.2); overflow: hidden; box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.9), 0 0 50px -5px rgba(168, 85, 247, 0.2);">
          
          <!-- 1. HEADER (LOGO & PILL BADGE) -->
          <tr>
            <td align="center" bgcolor="#1e053a" class="email-bg-header" style="padding: 48px 32px 28px 32px; text-align: center; background-color: #1e053a !important; background: radial-gradient(circle at 50% -10%, #3b0764 0%, #1e053a 45%, #07031c 90%);">
              
              <!-- REAL NEKOAI LOGO IMAGE -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 20px auto;">
                <tr>
                  <td align="center">
                    <img src="${escapeHtml(logoUrl)}" alt="NekoAI" width="190" style="display: block; width: 190px; max-width: 100%; height: auto; margin: 0 auto; border: 0;" />
                  </td>
                </tr>
              </table>

              <!-- LANDING PAGE PILL BADGE -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto;">
                <tr>
                  <td bgcolor="#1b0933" class="email-bg-badge" style="background-color: #1b0933 !important; background: rgba(88, 28, 135, 0.35); border: 1px solid rgba(192, 132, 252, 0.4); border-radius: 9999px; padding: 6px 18px; text-align: center;">
                    <span style="display: inline-block; width: 6px; height: 6px; background-color: #d946ef; border-radius: 50%; vertical-align: middle; margin-right: 8px; box-shadow: 0 0 8px #d946ef;"></span>
                    <span class="email-text-badge" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; font-weight: 800; color: #e9d5ff !important; text-transform: uppercase; letter-spacing: 2px; vertical-align: middle;">
                      ${escapeHtml(badgeLabel)}
                    </span>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 2. HERO SECTION -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 32px 40px 20px 40px; background-color: #07031c !important;">
              
              <h1 class="email-text-title" style="color: #ffffff !important; font-size: 28px; font-weight: 900; margin: 0 0 14px 0; line-height: 1.25; letter-spacing: -0.8px;">
                ${heroTitle}
              </h1>

              <p class="email-text-body" style="font-size: 16px; line-height: 1.6; color: #cbd5e1 !important; margin: 0;">
                ${heroBody}
              </p>

            </td>
          </tr>

          <!-- 3. BLOCO DA LICENÇA (CLEAN & HIGHLIGHTED KEY) -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 10px 40px 24px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0c0521" class="email-bg-card-license" style="background-color: #0c0521 !important; border-radius: 18px; padding: 0;">
                <tr>
                  <td style="padding: 26px 24px; text-align: center;">
                    
                    <span class="email-text-purple" style="font-size: 12px; font-weight: 800; color: #c084fc !important; text-transform: uppercase; letter-spacing: 2px; display: block; margin-bottom: 14px;">
                      SUA CHAVE DE ATIVAÇÃO
                    </span>

                    <!-- KEY DISPLAY CONTAINER (SUBTLE CLEAN BORDER FOR FOCUS) -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto; width: 100%;">
                      <tr>
                        <td align="center" bgcolor="#14072b" class="email-bg-card-key" style="background-color: #14072b !important; background: linear-gradient(180deg, #180a34 0%, #0e0521 100%); border: 1px solid rgba(147, 51, 234, 0.4); border-radius: 14px; padding: 18px 22px;">
                          <span class="email-text-cyan" style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Monaco, Courier, monospace; font-size: 23px; font-weight: 800; color: #38bdf8 !important; letter-spacing: 2.5px; display: inline-block; word-break: break-all; text-shadow: 0 0 12px rgba(56, 189, 248, 0.4);">
                            ${escapeHtml(data.licenseKey)}
                          </span>
                        </td>
                      </tr>
                    </table>

                    <p class="email-text-muted" style="font-size: 13px; color: #a1a1aa !important; margin: 16px 0 0 0; line-height: 1.4;">
                      Copie sua chave para ativar o NekoAI no seu computador.
                    </p>

                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 4. INFORMAÇÕES DA LICENÇA (3 CLEAN CARDS, SEM BORDAS PESADAS) -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 36px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  ${isTest ? `
                  <!-- CARD: TIPO (TESTE) -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-purple" style="font-size: 11px; font-weight: 800; color: #c084fc !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      TIPO
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 15px; font-weight: 700; display: block; line-height: 1.3;">
                      Licença de teste
                    </strong>
                  </td>

                  <td class="responsive-spacer" width="3.5%">&nbsp;</td>

                  <!-- CARD: VALIDADE (TESTE) -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-magenta" style="font-size: 11px; font-weight: 800; color: #e879f9 !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      VALIDADE
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 13px; font-weight: 700; display: block; line-height: 1.3;">
                      ${escapeHtml(testDurationLabel)}
                    </strong>
                  </td>

                  <td class="responsive-spacer" width="3.5%">&nbsp;</td>

                  <!-- CARD: DISPOSITIVOS (TESTE) -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-cyan" style="font-size: 11px; font-weight: 800; color: #38bdf8 !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      DISPOSITIVOS
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 15px; font-weight: 700; display: block; line-height: 1.3;">
                      ${escapeHtml(devicesText)}
                    </strong>
                  </td>
                  ` : `
                  <!-- CARD: PLANO -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-purple" style="font-size: 11px; font-weight: 800; color: #c084fc !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      PLANO
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 15px; font-weight: 700; display: block; line-height: 1.3;">
                      ${escapeHtml(planName)}
                    </strong>
                  </td>

                  <td class="responsive-spacer" width="3.5%">&nbsp;</td>

                  <!-- CARD: DISPOSITIVOS -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-cyan" style="font-size: 11px; font-weight: 800; color: #38bdf8 !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      DISPOSITIVOS
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 15px; font-weight: 700; display: block; line-height: 1.3;">
                      ${escapeHtml(devicesText)}
                    </strong>
                  </td>

                  <td class="responsive-spacer" width="3.5%">&nbsp;</td>

                  <!-- CARD: VALIDADE -->
                  <td class="responsive-col email-bg-card-info" width="31%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-magenta" style="font-size: 11px; font-weight: 800; color: #e879f9 !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      VALIDADE
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 13px; font-weight: 700; display: block; line-height: 1.3;">
                      ${escapeHtml(validityText)}
                    </strong>
                  </td>
                  `}
                </tr>
              </table>

            </td>
          </tr>

          <!-- 5. DOWNLOAD SECTION (SEAMLESS FLOW WITH PROMINENT VIBRANT CTA) -->
          <tr>
            <td class="container-padding email-bg-container" align="center" bgcolor="#07031c" style="padding: 10px 40px 44px 40px; background-color: #07031c !important; text-align: center;">
              
              <h2 class="email-text-title" style="color: #ffffff !important; font-size: 24px; font-weight: 900; margin: 0 0 12px 0; line-height: 1.3; letter-spacing: -0.5px;">
                Seu NekoAI está pronto.
              </h2>

              <p class="email-text-body" style="font-size: 15px; line-height: 1.6; color: #cbd5e1 !important; margin: 0 auto 30px auto; max-width: 460px;">
                Baixe a versão mais recente do NekoAI para Windows e comece a usar sua licença.
              </p>

              <!-- MAIN CTA BUTTON -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto;">
                <tr>
                  <td align="center" bgcolor="#8b5cf6" class="email-bg-btn-download" style="border-radius: 9999px; background-color: #8b5cf6 !important; background-image: linear-gradient(90deg, #8B5CF6 0%, #D946EF 100%); box-shadow: 0 12px 32px -4px rgba(217, 70, 239, 0.65), 0 0 24px rgba(139, 92, 246, 0.5); mso-padding-alt: 0;">
                    <a href="${escapeHtml(downloadUrl)}" target="_blank" class="email-text-btn" style="display: inline-block; padding: 18px 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; font-weight: 900; color: #ffffff !important; text-decoration: none; text-transform: uppercase; letter-spacing: 0.8px; border-radius: 9999px; background-color: #8b5cf6; background-image: linear-gradient(90deg, #8B5CF6 0%, #D946EF 100%); border: 1px solid #f0abfc; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);">
                      BAIXAR NEKOAI &rarr;
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 6. COMO COMEÇAR (3 PASSOS LIMPOS, SEM CAIXA PESADA) -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 38px 40px; background-color: #07031c !important;">
              
              <h3 class="email-text-title" style="color: #ffffff !important; font-size: 18px; font-weight: 800; margin: 0 0 16px 0; letter-spacing: -0.4px;">
                Comece em 3 passos
              </h3>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0a041f" class="email-bg-card-steps" style="background-color: #0a041f !important; border-radius: 16px;">
                
                <!-- STEP 01 -->
                <tr>
                  <td style="padding: 18px 22px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="48" style="vertical-align: top;">
                          <span class="email-text-purple" style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 18px; font-weight: 900; color: #c084fc !important; display: inline-block;">
                            01
                          </span>
                        </td>
                        <td style="vertical-align: top;">
                          <strong class="email-text-title" style="color: #ffffff !important; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 4px;">BAIXE</strong>
                          <span class="email-text-body" style="color: #cbd5e1 !important; font-size: 14px; line-height: 1.4; display: block;">
                            Baixe o instalador do NekoAI para Windows.
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- STEP 02 -->
                <tr>
                  <td style="padding: 18px 22px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="48" style="vertical-align: top;">
                          <span class="email-text-magenta" style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 18px; font-weight: 900; color: #d946ef !important; display: inline-block;">
                            02
                          </span>
                        </td>
                        <td style="vertical-align: top;">
                          <strong class="email-text-title" style="color: #ffffff !important; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 4px;">INSTALE</strong>
                          <span class="email-text-body" style="color: #cbd5e1 !important; font-size: 14px; line-height: 1.4; display: block;">
                            Instale e abra o NekoAI no seu computador.
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- STEP 03 -->
                <tr>
                  <td style="padding: 18px 22px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="48" style="vertical-align: top;">
                          <span class="email-text-cyan" style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 18px; font-weight: 900; color: #38bdf8 !important; display: inline-block;">
                            03
                          </span>
                        </td>
                        <td style="vertical-align: top;">
                          <strong class="email-text-title" style="color: #ffffff !important; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 4px;">ATIVE</strong>
                          <span class="email-text-body" style="color: #cbd5e1 !important; font-size: 14px; line-height: 1.4; display: block;">
                            Cole sua chave de licença quando solicitado e comece a usar.
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>

            </td>
          </tr>

          <!-- 7. SUPORTE (CLEAN & SUBTLE) -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 40px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0d0624" class="email-bg-card-support" style="background-color: #0d0624 !important; border-radius: 16px;">
                <tr>
                  <td align="center" style="padding: 24px 20px; text-align: center;">
                    
                    <h4 class="email-text-title" style="color: #ffffff !important; font-size: 16px; font-weight: 800; margin: 0 0 6px 0;">
                      Precisa de ajuda?
                    </h4>
                    <p class="email-text-muted" style="color: #94a3b8 !important; font-size: 14px; margin: 0 auto 18px auto; padding: 0 12px; line-height: 1.4; max-width: 380px;">
                      Nossa equipe está pronta para ajudar você a começar.
                    </p>

                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto;">
                      <tr>
                        <td align="center">
                          <a href="${escapeHtml(supportUrl)}" target="_blank" class="email-bg-btn-support email-text-btn-support" style="display: inline-block; background-color: #240b4a !important; border: 1px solid rgba(168, 85, 247, 0.4); color: #e9d5ff !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; text-decoration: none; padding: 12px 22px; border-radius: 9999px; white-space: nowrap;">
                            FALAR COM SUPORTE &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 8. RODAPÉ -->
          <tr>
            <td align="center" bgcolor="#030014" class="email-bg-footer" style="padding: 30px 32px 38px 32px; background-color: #030014 !important; text-align: center;">
              
              <p class="email-text-purple" style="font-size: 13px; font-weight: 700; color: #a855f7 !important; margin: 0 0 10px 0; text-align: center;">
                NekoAI — App Builder
              </p>

              <p class="email-text-muted" style="font-size: 12px; color: #64748b !important; margin: 0 auto; padding: 0 12px; line-height: 1.5; text-align: center; max-width: 360px;">
                ${isTest ? "Este é um e-mail automático enviado com sua licença de teste." : "Este é um e-mail automático enviado após a confirmação do seu pagamento."}
              </p>

            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
