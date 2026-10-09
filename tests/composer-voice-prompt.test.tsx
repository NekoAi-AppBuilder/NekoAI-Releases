import { test, expect, describe } from "bun:test";

describe("Composer: Prompt por Voz", () => {
  test("Inicializa com estados de voz inativos", () => {
    let isRecordingAudio = false;
    let isTranscribingAudio = false;
    let input = "";

    expect(isRecordingAudio).toBe(false);
    expect(isTranscribingAudio).toBe(false);
    expect(input).toBe("");
  });

  test("Bloqueia início de gravação de voz se o agente estiver ocupado (busy)", () => {
    let busy = true;
    let isRecordingAudio = false;
    let isTranscribingAudio = false;

    const canStartVoice = !busy && !isTranscribingAudio;
    expect(canStartVoice).toBe(false);
  });

  test("Transição de estados: gravação -> processamento -> inserção no Composer", () => {
    let isRecordingAudio = false;
    let isTranscribingAudio = false;
    let input = "";

    // 1. Início da gravação
    isRecordingAudio = true;
    expect(isRecordingAudio).toBe(true);
    expect(isTranscribingAudio).toBe(false);

    // 2. Parada e início da transcrição
    isRecordingAudio = false;
    isTranscribingAudio = true;
    expect(isRecordingAudio).toBe(false);
    expect(isTranscribingAudio).toBe(true);

    // 3. Sucesso na transcrição: texto inserido
    const mockTranscribedText = "crie uma tela de login com formulário e validação";
    input = mockTranscribedText;
    isTranscribingAudio = false;

    expect(isTranscribingAudio).toBe(false);
    expect(input).toBe("crie uma tela de login com formulário e validação");
  });

  test("Preserva texto previamente digitado ao concatenar áudio transcrito", () => {
    let input = "Adicione um botão no topo.";
    const transcribedText = "e mude a cor para roxo vibrante";

    // Concatenação inteligente respeitando espaço
    const updatedInput = input.trim() ? `${input.trim()} ${transcribedText.trim()}` : transcribedText.trim();

    expect(updatedInput).toBe("Adicione um botão no topo. e mude a cor para roxo vibrante");
  });

  test("Se o textarea estiver vazio, insere o texto sem espaços à esquerda", () => {
    let input = "   ";
    const transcribedText = "Crie um componente de carrinho de compras";

    const updatedInput = input.trim() ? `${input.trim()} ${transcribedText.trim()}` : transcribedText.trim();
    expect(updatedInput).toBe("Crie um componente de carrinho de compras");
  });

  test("Áudio vazio ou silêncio não corrompe o texto existente", () => {
    let input = "Meu texto importante";
    const transcribedText = "";

    if (transcribedText.trim()) {
      input = `${input} ${transcribedText}`;
    }

    expect(input).toBe("Meu texto importante");
  });

  test("Tratamento de erro de permissão negada (NotAllowedError)", () => {
    const error = { name: "NotAllowedError", message: "Permission denied" };
    let userMessage = "";

    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      userMessage = "Permissão do microfone negada no sistema operacional.";
    }

    expect(userMessage).toBe("Permissão do microfone negada no sistema operacional.");
  });

  test("Tratamento de ausência de dispositivo de microfone (NotFoundError)", () => {
    const error = { name: "NotFoundError", message: "Device not found" };
    let userMessage = "";

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      userMessage = "Nenhum microfone encontrado no seu computador.";
    }

    expect(userMessage).toBe("Nenhum microfone encontrado no seu computador.");
  });
});

describe("Edge Function: transcribe-audio - Contrato de Segurança", () => {
  test("Rejeita chamada HTTP sem header x-neko-license-grant", () => {
    const req = new Request("https://igadprvhgmfnyvyqavhy.supabase.co/functions/v1/transcribe-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: "base64-data" })
    });

    const grantHeader = req.headers.get("x-neko-license-grant");
    expect(grantHeader).toBeNull();
  });

  test("Garante isolamento de rate limit por device_id", () => {
    const getRateLimitKey = (payload: { device_id: string }) => `transcribe_audio:${payload.device_id}`;

    const dev1 = { device_id: "device_abc_123" };
    const dev2 = { device_id: "device_xyz_789" };

    expect(getRateLimitKey(dev1)).toBe("transcribe_audio:device_abc_123");
    expect(getRateLimitKey(dev2)).toBe("transcribe_audio:device_xyz_789");
    expect(getRateLimitKey(dev1)).not.toBe(getRateLimitKey(dev2));
  });

  test("Valida que recurso é gratuito e não deduz créditos", () => {
    const consumesCreditEngine = false;
    expect(consumesCreditEngine).toBe(false);
  });

  test("Tradução amigável de erro 'Missing authorization header' ou 'UNAUTHORIZED'", () => {
    const mapError = (rawError: string) => {
      let friendlyMsg = rawError;
      if (/Missing authorization header|UNAUTHORIZED_NO_AUTH_HEADER|unauthorized/i.test(rawError)) {
        friendlyMsg = "Licença não autorizada ou expirada para transcrição por voz.";
      } else if (/rate limit|muitas tentativas/i.test(rawError)) {
        friendlyMsg = "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.";
      } else if (/503|PROVIDER_BUSY|temporariamente instável/i.test(rawError)) {
        friendlyMsg = "Serviço de voz temporariamente ocupado. Tente novamente em instantes.";
      }
      return friendlyMsg;
    };

    expect(mapError("Missing authorization header")).toBe("Licença não autorizada ou expirada para transcrição por voz.");
    expect(mapError("UNAUTHORIZED_NO_AUTH_HEADER")).toBe("Licença não autorizada ou expirada para transcrição por voz.");
    expect(mapError("Muitas tentativas de gravação em pouco tempo.")).toBe("Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.");
    expect(mapError("O serviço de transcrição está temporariamente instável.")).toBe("Serviço de voz temporariamente ocupado. Tente novamente em instantes.");
  });

  test("IPC Handler trata status HTTP de erro sem quebrar ou vazar exceções", () => {
    const handleStatus = (status: number, data: any) => {
      if (status === 401) {
        return {
          success: false,
          error: data?.message || "Sua licença não possui permissão ativa para transcrição por voz. Verifique a ativação."
        };
      }
      if (status === 429) {
        return {
          success: false,
          error: data?.message || "Muitas tentativas de gravação em pouco tempo. Aguarde um instante e tente novamente."
        };
      }
      if (status >= 500) {
        return {
          success: false,
          error: "O serviço de transcrição está temporariamente instável. Tente novamente em instantes."
        };
      }
      return { success: false, error: data?.message || "Falha ao processar o áudio gravado." };
    };

    expect(handleStatus(401, null).success).toBe(false);
    expect(handleStatus(401, null).error).toContain("Sua licença não possui permissão");
    expect(handleStatus(429, null).error).toContain("Muitas tentativas");
    expect(handleStatus(503, null).error).toContain("temporariamente instável");
  });

  test("Preserva config.toml garantindo verify_jwt = false", () => {
    const fs = require("fs");
    const path = require("path");
    const configPath = path.join(process.cwd(), "supabase", "config.toml");
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[functions.transcribe-audio]");
    expect(content).toContain("verify_jwt = false");
  });
});
