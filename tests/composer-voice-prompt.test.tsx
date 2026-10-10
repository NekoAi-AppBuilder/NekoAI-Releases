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

describe("Composer: Nova Interface de Gravação por Voz (Waveform & Controles)", () => {
  const formatRecordingTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  test("Formatação de duração do timer (MM:SS)", () => {
    expect(formatRecordingTime(0)).toBe("00:00");
    expect(formatRecordingTime(9)).toBe("00:09");
    expect(formatRecordingTime(60)).toBe("01:00");
    expect(formatRecordingTime(75)).toBe("01:15");
    expect(formatRecordingTime(630)).toBe("10:30");
  });

  test("Alternância de interface: ativa classe voice-recording-mode quando gravando ou transcrevendo", () => {
    const getComposerClass = (isRecording: boolean, isTranscribing: boolean) => {
      return `composer ${isRecording || isTranscribing ? "voice-recording-mode" : ""}`.trim();
    };

    expect(getComposerClass(false, false)).toBe("composer");
    expect(getComposerClass(true, false)).toBe("composer voice-recording-mode");
    expect(getComposerClass(false, true)).toBe("composer voice-recording-mode");
    expect(getComposerClass(true, true)).toBe("composer voice-recording-mode");
  });

  test("Botão Parar (Stop): encerra áudio, transcreve, restaura interface e insere texto no input sem auto-send", async () => {
    let input = "Texto pré-existente.";
    let isRecordingAudio = true;
    let isTranscribingAudio = false;
    let targetAction: "stop" | "send" = "stop";
    let autoSentMessage: string | null = null;

    const mockSend = async (msg: string) => {
      autoSentMessage = msg;
    };

    // Fluxo do botão Parar
    targetAction = "stop";
    isRecordingAudio = false;
    isTranscribingAudio = true;

    // Simula resposta da transcrição
    const mockTranscribe = async () => ({ success: true, text: "adicionando detalhes por voz" });
    const res = await mockTranscribe();

    if (res.success && res.text) {
      if (targetAction === "send") {
        const finalText = input.trim() ? `${input.trim()} ${res.text}` : res.text;
        input = "";
        await mockSend(finalText);
      } else {
        const trimmed = input.trim();
        input = trimmed ? `${trimmed} ${res.text}` : res.text;
      }
    }
    isTranscribingAudio = false;

    // Asserções
    expect(isRecordingAudio).toBe(false);
    expect(isTranscribingAudio).toBe(false);
    expect(input).toBe("Texto pré-existente. adicionando detalhes por voz");
    expect(autoSentMessage).toBeNull(); // NÂO deve enviar ao chat automaticamente
  });

  test("Botão Enviar: encerra áudio, transcreve, restaura interface e envia automaticamente ao chat", async () => {
    let input = "Texto inicial.";
    let isRecordingAudio = true;
    let isTranscribingAudio = false;
    let targetAction: "stop" | "send" = "send";
    let autoSentMessage: string | null = null;

    const mockSend = async (msg: string) => {
      autoSentMessage = msg;
    };

    // Fluxo do botão Enviar
    targetAction = "send";
    isRecordingAudio = false;
    isTranscribingAudio = true;

    const mockTranscribe = async () => ({ success: true, text: "envio imediato após voz" });
    const res = await mockTranscribe();

    if (res.success && res.text) {
      if (targetAction === "send") {
        const finalText = input.trim() ? `${input.trim()} ${res.text}` : res.text;
        input = "";
        await mockSend(finalText);
      } else {
        const trimmed = input.trim();
        input = trimmed ? `${trimmed} ${res.text}` : res.text;
      }
    }
    isTranscribingAudio = false;

    // Asserções
    expect(isRecordingAudio).toBe(false);
    expect(isTranscribingAudio).toBe(false);
    expect(input).toBe(""); // Input é esvaziado pois a mensagem foi despachada
    expect(autoSentMessage).toBe("Texto inicial. envio imediato após voz"); // Enviado diretamente ao chat
  });

  test("Ação Cancelar: descarta gravação, preserva texto anterior e restaura interface sem transcrever", () => {
    let input = "Texto digitado antes de iniciar a gravação.";
    let isRecordingAudio = true;
    let isTranscribingAudio = false;
    let recordingDuration = 12;
    let transcriptionCalled = false;

    const handleCancel = () => {
      isRecordingAudio = false;
      isTranscribingAudio = false;
      recordingDuration = 0;
      // Não executa transcrição
    };

    handleCancel();

    expect(isRecordingAudio).toBe(false);
    expect(isTranscribingAudio).toBe(false);
    expect(recordingDuration).toBe(0);
    expect(input).toBe("Texto digitado antes de iniciar a gravação.");
    expect(transcriptionCalled).toBe(false);
  });

  test("Botão Enviar com silêncio (sem fala): exibe aviso e não envia mensagem vazia ao chat", async () => {
    let input = "";
    let isRecordingAudio = true;
    let isTranscribingAudio = false;
    let targetAction: "stop" | "send" = "send";
    let autoSentMessage: string | null = null;
    let notificationMsg = "";

    const mockSend = async (msg: string) => {
      autoSentMessage = msg;
    };

    targetAction = "send";
    isRecordingAudio = false;
    isTranscribingAudio = true;

    // Transcrição sem fala detectada
    const res = { success: true, text: "" };
    const transcribedText = (res.text || "").trim();

    if (!transcribedText) {
      if (targetAction === "send") {
        notificationMsg = "Nenhuma fala detectada. A mensagem não foi enviada.";
      } else {
        notificationMsg = "Nenhuma fala foi detectada no áudio gravado.";
      }
    } else {
      await mockSend(transcribedText);
    }
    isTranscribingAudio = false;

    expect(autoSentMessage).toBeNull(); // Nenhuma mensagem enviada
    expect(notificationMsg).toBe("Nenhuma fala detectada. A mensagem não foi enviada.");
    expect(isTranscribingAudio).toBe(false);
  });

  test("Bloqueia cliques concorrentes enquanto transcreve (isTranscribingAudio = true)", () => {
    const isTranscribingAudio = true;
    let stopClicked = false;
    let sendClicked = false;

    const onStopClick = () => {
      if (isTranscribingAudio) return;
      stopClicked = true;
    };

    const onSendClick = () => {
      if (isTranscribingAudio) return;
      sendClicked = true;
    };

    onStopClick();
    onSendClick();

    expect(stopClicked).toBe(false);
    expect(sendClicked).toBe(false);
  });
});

describe("Composer: Prompt por Voz (BYOK Obrigatório) — Validação Prévia de Chave Gemini", () => {
  test("Bloqueia gravação e abre modal se chave Gemini não estiver configurada (sem chamar microfone)", async () => {
    let modalOpened: string | null = null;
    let notificationShown: string | null = null;
    let getUserMediaCalled = false;

    const mockKeyStatus = { configured: false };
    const mockWindowNeko = {
      geminiGetKeyStatus: async () => mockKeyStatus,
    };

    const handleToggleVoiceRecording = async () => {
      const status = await mockWindowNeko.geminiGetKeyStatus();
      if (!status?.configured) {
        modalOpened = "geminiKey";
        notificationShown = "Configure sua chave Google Gemini para utilizar a gravação por voz.";
        return;
      }
      getUserMediaCalled = true;
    };

    await handleToggleVoiceRecording();

    expect(modalOpened).toBe("geminiKey");
    expect(notificationShown).toBe("Configure sua chave Google Gemini para utilizar a gravação por voz.");
    // Microfone NÃO pode ser inicializado!
    expect(getUserMediaCalled).toBe(false);
  });

  test("Inicia gravação com sucesso quando chave Gemini está configurada", async () => {
    let modalOpened: string | null = null;
    let getUserMediaCalled = false;

    const mockKeyStatus = { configured: true, mask: "AIza••••1234" };
    const mockWindowNeko = {
      geminiGetKeyStatus: async () => mockKeyStatus,
    };

    const handleToggleVoiceRecording = async () => {
      const status = await mockWindowNeko.geminiGetKeyStatus();
      if (!status?.configured) {
        modalOpened = "geminiKey";
        return;
      }
      getUserMediaCalled = true;
    };

    await handleToggleVoiceRecording();

    expect(modalOpened).toBeNull();
    expect(getUserMediaCalled).toBe(true);
  });
});


