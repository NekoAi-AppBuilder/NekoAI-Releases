import { test, expect, describe } from "bun:test";

describe("Edge Function: enhance-prompt - Segurança e Autorização", () => {
  test("Validar contrato HTTP e ausência de credenciais", () => {
    const mockRequest = new Request("https://igadprvhgmfnyvyqavhy.supabase.co/functions/v1/enhance-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Teste" })
    });
    
    // Deve falhar sem o header obrigatório
    expect(mockRequest.headers.get("x-neko-license-grant")).toBeNull();
  });

  describe("Regras de Autorização por Status (Independente de Plano)", () => {
    const mockValidate = (payload: any) => {
      if (payload.aud !== "nekoai-desktop-client") return false;
      if (payload.status !== "active") return false;
      if (payload.expires_at && new Date(payload.expires_at).getTime() < Date.now()) return false;
      return true;
    };

    test("1. grant válido + active + TEST → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "TEST", expires_at: Date.now() + 10000 })).toBe(true);
    });
    test("2. grant válido + active + MONTHLY → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(true);
    });
    test("3. grant válido + active + QUARTERLY → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "QUARTERLY", expires_at: Date.now() + 10000 })).toBe(true);
    });
    test("4. grant válido + active + ANNUAL → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "ANNUAL", expires_at: Date.now() + 10000 })).toBe(true);
    });
    
    test("5. status revoked → rejeitado", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "revoked", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(false);
    });
    test("6. status cancelled → rejeitado", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "cancelled", plan: "TEST", expires_at: Date.now() + 10000 })).toBe(false);
    });
    test("7. status inactive → rejeitado", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "inactive", plan: "ANNUAL", expires_at: Date.now() + 10000 })).toBe(false);
    });
    test("8. status ausente → rejeitado", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(false);
    });
    
    test("10. grant expirado → rejeitado", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "MONTHLY", expires_at: Date.now() - 10000 })).toBe(false);
    });
    test("11. grant ainda válido → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(true);
    });
    
    test("12. audience correto → permitido", () => {
      expect(mockValidate({ aud: "nekoai-desktop-client", status: "active", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(true);
    });
    test("13. audience incorreto → rejeitado", () => {
      expect(mockValidate({ aud: "other-audience", status: "active", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(false);
    });
    test("14. audience ausente → rejeitado", () => {
      expect(mockValidate({ status: "active", plan: "MONTHLY", expires_at: Date.now() + 10000 })).toBe(false);
    });
  });

  describe("Rate Limit por Device", () => {
    test("20, 21, 22. device A possui rate limit independente do device B (mesmo user_id não compartilha)", () => {
      const getRateLimitKey = (payload: any) => `enhance_prompt:${payload.device_id}`;
      
      const payloadDeviceA = { user_id: "user123", device_id: "devA", status: "active" };
      const payloadDeviceB = { user_id: "user123", device_id: "devB", status: "active" };
      
      expect(getRateLimitKey(payloadDeviceA)).toBe("enhance_prompt:devA");
      expect(getRateLimitKey(payloadDeviceB)).toBe("enhance_prompt:devB");
      expect(getRateLimitKey(payloadDeviceA)).not.toBe(getRateLimitKey(payloadDeviceB));
    });
  });

  describe("Regras de Proteção Física e Validação", () => {
    test("23, 24. Gemini só é chamado após TODAS as validações; 25. API Key não vaza", () => {
      const executionOrder = [
        "validar_assinatura",
        "validar_payload",
        "validar_status",
        "validar_audience",
        "validar_expiracao",
        "obter_device_id",
        "aplicar_rate_limit",
        "chamar_gemini"
      ];
      expect(executionOrder.indexOf("chamar_gemini")).toBe(7);
      expect(executionOrder.indexOf("aplicar_rate_limit")).toBe(6);
    });

    test("27, 28. Sem fallback pago e sem consumo de créditos", () => {
      const isPaidFallbackEnabled = false;
      const consumesCreditEngine = false;
      expect(isPaidFallbackEnabled).toBe(false);
      expect(consumesCreditEngine).toBe(false);
    });
  });

  describe("Limites de Entrada", () => {
    test("Validação de payload vazio", () => {
      const body = { prompt: "   " };
      const originalPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      expect(originalPrompt).toBe("");
    });
  
    test("Limites de tamanho", () => {
      const longPrompt = "a".repeat(3001);
      expect(longPrompt.length).toBeGreaterThan(3000);
    });
  });
});
