// supabase/functions/_shared/email/email-client.ts
// Cliente de envio de e-mails transacionais via Resend API (Edge Function / Deno Runtime)

import {
  LicenseEmailData,
  generateLicenseEmailSubject,
  generateLicenseEmailHtml,
  generateLicenseEmailPlainText,
} from "./license-email-template.ts";

export interface SendEmailResult {
  ok: boolean;
  email_id?: string;
  error_code?: string;
  message?: string;
}

export class EmailClient {
  private resendApiKey?: string;
  private defaultFrom: string;
  private defaultDownloadUrl: string;
  private defaultSupportUrl: string;

  constructor() {
    this.resendApiKey = Deno.env.get("RESEND_API_KEY") || undefined;
    this.defaultFrom = Deno.env.get("EMAIL_FROM") || "NekoAI <licencas@nekoai.app>";
    this.defaultDownloadUrl = Deno.env.get("APP_DOWNLOAD_URL") || "https://nekoai.app/download";
    this.defaultSupportUrl = Deno.env.get("SUPPORT_WHATSAPP") || "https://wa.me/5511999999999";
  }

  /**
   * Envia o e-mail transacional com a chave de ativação para o comprador.
   */
  public async sendLicenseDelivery(data: LicenseEmailData): Promise<SendEmailResult> {
    if (!data.customerEmail || !data.customerEmail.includes("@")) {
      console.warn(`[EmailClient] E-mail de destino inválido ou ausente: "${data.customerEmail}"`);
      return {
        ok: false,
        error_code: "INVALID_EMAIL",
        message: "Endereço de e-mail inválido.",
      };
    }

    if (!data.licenseKey) {
      console.error("[EmailClient] Tentativa de envio com licenseKey ausente.");
      return {
        ok: false,
        error_code: "MISSING_LICENSE_KEY",
        message: "Chave de licença ausente para entrega.",
      };
    }

    const apiKey = this.resendApiKey || Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      console.warn(
        `[EmailClient] AVISO: RESEND_API_KEY não configurada no Supabase Vault. E-mail para ${data.customerEmail} não foi despachado.`
      );
      return {
        ok: false,
        error_code: "RESEND_KEY_MISSING",
        message: "Serviço de e-mail não configurado. O administrador deve configurar a RESEND_API_KEY no Supabase.",
      };
    }

    const emailData: LicenseEmailData = {
      ...data,
      downloadUrl: data.downloadUrl || this.defaultDownloadUrl,
      supportUrl: data.supportUrl || this.defaultSupportUrl,
    };

    const subject = generateLicenseEmailSubject(emailData);
    const html = generateLicenseEmailHtml(emailData);
    const text = generateLicenseEmailPlainText(emailData);

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.defaultFrom,
          to: [data.customerEmail.trim().toLowerCase()],
          subject,
          html,
          text,
        }),
      });

      const responseBody = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(
          `[EmailClient] Erro retornado pela API do Resend (${response.status}):`,
          responseBody
        );
        return {
          ok: false,
          error_code: "RESEND_API_ERROR",
          message: responseBody.message || `Erro HTTP ${response.status} ao enviar e-mail.`,
        };
      }

      console.log(
        `[EmailClient] E-mail de licença entregue com sucesso para ${data.customerEmail} (ID: ${responseBody.id}).`
      );

      return {
        ok: true,
        email_id: responseBody.id,
        message: "E-mail de entrega de licença enviado com sucesso.",
      };
    } catch (err: any) {
      console.error("[EmailClient] Exceção de rede ao conectar com a API Resend:", err);
      return {
        ok: false,
        error_code: "NETWORK_ERROR",
        message: err.message || "Falha de rede ao conectar com o serviço de e-mail.",
      };
    }
  }
}

export const emailClient = new EmailClient();
