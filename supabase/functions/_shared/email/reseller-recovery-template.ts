// supabase/functions/_shared/email/reseller-recovery-template.ts
// Template oficial de e-mail de recuperação/redefinição de acesso do Revendedor NekoAI
// Compartilha exatamente a mesma identidade visual e estrutura técnica do template de licenças

import { DEFAULT_NEKO_LOGO_URL } from "./license-email-template.ts";

export interface RecoveryEmailData {
  email: string;
  recoveryLink: string;
  supportUrl?: string;
  logoUrl?: string;
}

export function generateRecoveryEmailSubject(): string {
  return "NekoAI — Recuperação de Acesso [Painel do Revendedor]";
}

export function generateRecoveryEmailPlainText(data: RecoveryEmailData): string {
  const supportUrl = data.supportUrl || "https://wa.me/5511999999999";

  return `
NEKOAI — PAINEL DO REVENDEDOR

Recuperação de Acesso ao Painel

Olá! Foi solicitada a redefinição de acesso para sua conta de Revendedor NekoAI (${data.email}).

==================================================
LINK PARA REDEFINIR SUA SENHA:
${data.recoveryLink}
==================================================

Clique no link acima para definir sua nova senha e acessar o painel.

INFORMAÇÕES DA CONTA:
- E-MAIL: ${data.email}
- TIPO: Painel do Revendedor
- FINALIDADE: Redefinição de senha e acesso seguro

AVISO DE SEGURANÇA:
Se você não solicitou esta redefinição, nenhuma ação é necessária. Sua conta permanece segura.

SUPORTE:
Precisa de ajuda?
Nossa equipe está à disposição para auxiliá-lo:
${supportUrl}

--------------------------------------------------
NekoAI — App Builder
Este é um e-mail automático enviado para recuperação de credenciais de acesso.
`.trim();
}

export function generateRecoveryEmailHtml(data: RecoveryEmailData): string {
  const logoUrl = data.logoUrl || DEFAULT_NEKO_LOGO_URL;
  const supportUrl = data.supportUrl || "https://wa.me/5511999999999";
  const userEmailEscaped = escapeHtml(data.email.trim().toLowerCase());
  const recoveryLinkEscaped = escapeHtml(data.recoveryLink);

  const badgeLabel = "PAINEL DO REVENDEDOR";
  const heroTitle = `Recuperação de <span class="email-text-magenta" style="color: #e879f9 !important;">Acesso</span>`;
  const heroBody = `Olá! Recebemos uma solicitação para redefinir a senha de acesso à sua conta de Revendedor NekoAI associada ao e-mail <strong class="email-text-title" style="color: #ffffff !important;">${userEmailEscaped}</strong>.`;

  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Recuperação de Acesso — NekoAI</title>
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
        
        <!-- MAIN CONTAINER -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#07031c" class="email-bg-container" style="max-width: 620px; margin: 0 auto; background-color: #07031c !important; border-radius: 24px; border: 1px solid rgba(124, 58, 237, 0.2); overflow: hidden; box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.9), 0 0 50px -5px rgba(168, 85, 247, 0.2);">
          
          <!-- 1. HEADER (LOGO & PILL BADGE) -->
          <tr>
            <td align="center" bgcolor="#1e053a" class="email-bg-header" style="padding: 48px 32px 28px 32px; text-align: center; background-color: #1e053a !important; background: radial-gradient(circle at 50% -10%, #3b0764 0%, #1e053a 45%, #07031c 90%);">
              
              <!-- NEKOAI LOGO IMAGE -->
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

          <!-- 3. ACTION / BUTTON CARD SECTION -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 10px 40px 28px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0c0521" class="email-bg-card-license" style="background-color: #0c0521 !important; border-radius: 18px; padding: 0;">
                <tr>
                  <td style="padding: 32px 24px; text-align: center;">
                    
                    <span class="email-text-purple" style="font-size: 12px; font-weight: 800; color: #c084fc !important; text-transform: uppercase; letter-spacing: 2px; display: block; margin-bottom: 12px;">
                      DEFINIÇÃO DE NOVA SENHA
                    </span>

                    <p class="email-text-body" style="font-size: 15px; line-height: 1.6; color: #cbd5e1 !important; margin: 0 auto 24px auto; max-width: 440px;">
                      Para criar uma nova credencial e restaurar seu acesso ao Painel de Revendedor, clique no botão abaixo:
                    </p>

                    <!-- MAIN CTA BUTTON -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto;">
                      <tr>
                        <td align="center" bgcolor="#8b5cf6" class="email-bg-btn-download" style="border-radius: 9999px; background-color: #8b5cf6 !important; background-image: linear-gradient(90deg, #8B5CF6 0%, #D946EF 100%); box-shadow: 0 12px 32px -4px rgba(217, 70, 239, 0.65), 0 0 24px rgba(139, 92, 246, 0.5); mso-padding-alt: 0;">
                          <a href="${recoveryLinkEscaped}" target="_blank" class="email-text-btn" style="display: inline-block; padding: 18px 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; font-weight: 900; color: #ffffff !important; text-decoration: none; text-transform: uppercase; letter-spacing: 0.8px; border-radius: 9999px; background-color: #8b5cf6; background-image: linear-gradient(90deg, #8B5CF6 0%, #D946EF 100%); border: 1px solid #f0abfc; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);">
                            REDEFINIR SENHA &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p class="email-text-muted" style="font-size: 13px; color: #a1a1aa !important; margin: 20px 0 0 0; line-height: 1.4;">
                      Este link é pessoal e intransferível. Válido para a conta <strong>${userEmailEscaped}</strong>.
                    </p>

                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 4. INFORMAÇÕES DA CONTA (2 CLEAN CARDS) -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 32px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <!-- CARD: TIPO DE ACESSO -->
                  <td class="responsive-col email-bg-card-info" width="48%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-purple" style="font-size: 11px; font-weight: 800; color: #c084fc !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      TIPO DE ACESSO
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 14px; font-weight: 700; display: block; line-height: 1.3;">
                      Painel do Revendedor
                    </strong>
                  </td>

                  <td class="responsive-spacer" width="4%">&nbsp;</td>

                  <!-- CARD: SEGURANÇA -->
                  <td class="responsive-col email-bg-card-info" width="48%" bgcolor="#0c0624" style="vertical-align: top; background-color: #0c0624 !important; border-radius: 14px; padding: 18px 16px;">
                    <span class="email-text-cyan" style="font-size: 11px; font-weight: 800; color: #38bdf8 !important; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">
                      SEGURANÇA
                    </span>
                    <strong class="email-text-title" style="color: #ffffff !important; font-size: 13px; font-weight: 700; display: block; line-height: 1.3;">
                      Link Seguro & Criptografado
                    </strong>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 5. INSTRUÇÃO / AVISO DE SEGURANÇA -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 36px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0a041f" class="email-bg-card-steps" style="background-color: #0a041f !important; border-radius: 16px;">
                <tr>
                  <td style="padding: 20px 22px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="40" style="vertical-align: top;">
                          <span class="email-text-magenta" style="font-family: 'SFMono-Regular', Consolas, monospace; font-size: 18px; font-weight: 900; color: #d946ef !important; display: inline-block;">
                            &bull;
                          </span>
                        </td>
                        <td style="vertical-align: top;">
                          <strong class="email-text-title" style="color: #ffffff !important; font-size: 13px; text-transform: uppercase; letter-spacing: 0.8px; display: block; margin-bottom: 4px;">
                            Não reconhece esta solicitação?
                          </strong>
                          <span class="email-text-body" style="color: #cbd5e1 !important; font-size: 13px; line-height: 1.4; display: block;">
                            Se você não solicitou a redefinição de sua senha, desconsidere este e-mail. Nenhuma alteração foi realizada em suas credenciais.
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- 6. SUPORTE -->
          <tr>
            <td class="container-padding email-bg-container" bgcolor="#07031c" style="padding: 0 40px 40px 40px; background-color: #07031c !important;">
              
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#0d0624" class="email-bg-card-support" style="background-color: #0d0624 !important; border-radius: 16px;">
                <tr>
                  <td align="center" style="padding: 24px 20px; text-align: center;">
                    
                    <h4 class="email-text-title" style="color: #ffffff !important; font-size: 16px; font-weight: 800; margin: 0 0 6px 0;">
                      Precisa de ajuda?
                    </h4>
                    <p class="email-text-muted" style="color: #94a3b8 !important; font-size: 14px; margin: 0 auto 18px auto; padding: 0 12px; line-height: 1.4; max-width: 380px;">
                      Nossa equipe de suporte está à disposição para auxiliá-lo.
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

          <!-- 7. RODAPÉ -->
          <tr>
            <td align="center" bgcolor="#030014" class="email-bg-footer" style="padding: 30px 32px 38px 32px; background-color: #030014 !important; text-align: center;">
              
              <p class="email-text-purple" style="font-size: 13px; font-weight: 700; color: #a855f7 !important; margin: 0 0 10px 0; text-align: center;">
                NekoAI — App Builder
              </p>

              <p class="email-text-muted" style="font-size: 12px; color: #64748b !important; margin: 0 auto; padding: 0 12px; line-height: 1.5; text-align: center; max-width: 360px;">
                Este é um e-mail de segurança do NekoAI referente ao acesso administrativo e operacional do revendedor.
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
