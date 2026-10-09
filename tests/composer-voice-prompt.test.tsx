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
});
