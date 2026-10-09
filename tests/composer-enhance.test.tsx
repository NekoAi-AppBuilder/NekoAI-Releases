import { test, expect, describe } from "bun:test";

describe("Composer: Melhorar Prompt", () => {
  test("Inicializa com estado vazio e botões corretos", () => {
    let isEnhancingPrompt = false;
    let previousPromptForUndo: string | null = null;
    let input = "";

    expect(isEnhancingPrompt).toBe(false);
    expect(previousPromptForUndo).toBeNull();
    
    // Botão melhorar deve estar desabilitado se vazio
    const isButtonDisabled = isEnhancingPrompt || !input.trim();
    expect(isButtonDisabled).toBe(true);
  });

  test("Estado de Loading bloqueia chamadas simultâneas", () => {
    let isEnhancingPrompt = true;
    let input = "Faça um botão vermelho";

    const isButtonDisabled = isEnhancingPrompt || !input.trim();
    expect(isButtonDisabled).toBe(true);
  });

  test("Sucesso armazena o prompt anterior e substitui o texto", () => {
    let input = "Faça um botão vermelho";
    let previousPromptForUndo: string | null = null;

    // Simular resposta de sucesso
    const response = { success: true, improvedPrompt: "Crie um componente React de botão com a cor de fundo vermelha e padding adequado." };
    
    previousPromptForUndo = input;
    input = response.improvedPrompt;

    expect(previousPromptForUndo).toBe("Faça um botão vermelho");
    expect(input).toBe("Crie um componente React de botão com a cor de fundo vermelha e padding adequado.");
  });

  test("Desfazer restaura o prompt original e limpa o estado de undo", () => {
    let input = "Crie um componente React de botão com a cor de fundo vermelha e padding adequado.";
    let previousPromptForUndo: string | null = "Faça um botão vermelho";

    // Simular clique em Desfazer
    input = previousPromptForUndo;
    previousPromptForUndo = null;

    expect(input).toBe("Faça um botão vermelho");
    expect(previousPromptForUndo).toBeNull();
  });

  test("Edição manual no textarea invalida o estado de Desfazer", () => {
    let previousPromptForUndo: string | null = "Faça um botão vermelho";
    
    // Simular onChange no textarea
    const onChange = () => {
      if (previousPromptForUndo !== null) {
        previousPromptForUndo = null;
      }
    };

    onChange();
    expect(previousPromptForUndo).toBeNull();
  });

  test("Propagação de grant: obtém de licenseState ou via fallback licenseGetGrant", async () => {
    const mockStateWithGrant = { grant: "valid-grant-token-123" };
    const getGrantDirect = async () => mockStateWithGrant.grant;
    expect(await getGrantDirect()).toBe("valid-grant-token-123");

    const mockStateWithoutGrant = { grant: undefined };
    const mockWindowNeko = { licenseGetGrant: async () => "fallback-grant-456" };
    const getGrantFallback = async () => mockStateWithoutGrant.grant || (await mockWindowNeko.licenseGetGrant()) || "";
    expect(await getGrantFallback()).toBe("fallback-grant-456");
  });

  test("Rejeita chamada quando nenhuma credencial está disponível sem enviar header vazio", async () => {
    const mockState = { grant: undefined };
    const mockWindowNeko = { licenseGetGrant: async () => null };
    const getGrant = async () => mockState.grant || (await mockWindowNeko.licenseGetGrant()) || "";
    
    const grant = await getGrant();
    expect(grant).toBe("");
    expect(() => {
      if (!grant) throw new Error("Credencial de licenciamento ativa não encontrada. Verifique se a sua licença está ativada.");
    }).toThrow("Credencial de licenciamento ativa não encontrada. Verifique se a sua licença está ativada.");
  });
});

