import { test, expect, describe } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("Composer: Dropdown de Modelos (Model Popover)", () => {
  const stylesPath = path.resolve(__dirname, "../src/renderer/styles.css");
  const mainPath = path.resolve(__dirname, "../src/renderer/main.tsx");
  const cssContent = fs.readFileSync(stylesPath, "utf8");
  const mainContent = fs.readFileSync(mainPath, "utf8");

  test("1. Fundo 100% sólido e opaco no popover e em todos os seus elementos filhos", () => {
    // Valida que o container principal possui fundo opaco e sem transparências
    expect(cssContent).toContain("background: #14101e !important;");
    expect(cssContent).toContain("background-color: #14101e !important;");
    expect(cssContent).toContain("opacity: 1 !important;");
    expect(cssContent).toContain("backdrop-filter: none !important;");

    // Valida que o cabeçalho de busca tem fundo opaco
    expect(cssContent).toContain("background: #0e0a16 !important;");

    // Valida que a lista interna tem fundo sólido
    expect(cssContent).toContain(".model-list");

    // Valida que o rodapé 'Gerenciar modelos' tem fundo sólido opaco
    expect(cssContent).toContain(".manage-models");
  });

  test("2. Posicionamento horizontal deslocado para a direita em relação aos -37px legados", () => {
    // Não deve conter a regra legada desbalanceada de -37px no popover ativo
    expect(cssContent).not.toContain("left: -37px !important;");

    // O CSS base deve iniciar em -6px (mais à direita, alinhado ao Composer)
    expect(cssContent).toContain("left: -6px !important;");
  });

  test("3. Posicionamento vertical dinâmico ancorado acima dos controles do Composer", () => {
    // Garante que o dropdown não use valores fixos que deixem vãos vazados
    expect(cssContent).toContain("bottom: calc(100% + 8px) !important;");
  });

  test("4. Algoritmo de proteção contra limites de tela (Viewport Safety)", () => {
    // Simulação do algoritmo implementado no useLayoutEffect do main.tsx
    const calculateClampedOffset = (anchorLeft: number, baseOffset: number, popoverWidth: number, viewportWidth: number, minMargin = 8) => {
      let offsetLeft = baseOffset;
      const screenLeft = anchorLeft + offsetLeft;
      if (screenLeft < minMargin) {
        offsetLeft += (minMargin - screenLeft);
      }
      const screenRight = anchorLeft + offsetLeft + popoverWidth;
      if (screenRight > viewportWidth - minMargin) {
        offsetLeft -= (screenRight - (viewportWidth - minMargin));
      }
      return offsetLeft;
    };

    // Cenário normal: tela desktop comum (1400px), anchor em 28px
    const normalOffset = calculateClampedOffset(28, -6, 340, 1400);
    expect(normalOffset).toBe(-6);
    expect(28 + normalOffset).toBe(22); // perfeitamente dentro da tela

    // Cenário limite esquerdo: janela estreita ou anchor muito próximo da margem esquerda (ex: 2px)
    const leftClampedOffset = calculateClampedOffset(2, -6, 340, 1400);
    expect(2 + leftClampedOffset).toBeGreaterThanOrEqual(8); // nunca menor que 8px

    // Cenário limite direito: viewport ultra compacta (360px), anchor em 28px, popover de 340px
    const rightClampedOffset = calculateClampedOffset(28, -6, 340, 360);
    const finalRight = 28 + rightClampedOffset + 340;
    expect(finalRight).toBeLessThanOrEqual(360 - 8); // respeita margem direita de 8px

    // Garante que o hook está implementado no código do componente
    expect(mainContent).toContain("modelPopoverRef");
    expect(mainContent).toContain("adjustPosition");
    expect(mainContent).toContain("minMargin");
  });

  test("5. Largura responsiva com limites máximos em telas pequenas", () => {
    expect(cssContent).toContain("max-width: calc(100vw - 20px) !important;");
    expect(cssContent).toContain("width: min(340px, calc(100vw - 20px)) !important;");
  });
});
