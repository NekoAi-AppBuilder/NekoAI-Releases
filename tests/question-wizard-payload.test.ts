import { describe, it, expect } from "vitest";

describe("Question Wizard Payload Formatting", () => {
  function simulateAnswerQuestion(value: string | string[][]) {
    const payload = Array.isArray(value) ? value : [value];
    return payload;
  }

  function simulateDisplayValue(value: string | string[][]) {
    return Array.isArray(value) ? value.map(group => group.join(", ")).join(" | ") : value;
  }

  it("CASO A — pergunta nativa single-select", () => {
    const input = [["Opção A"]];
    const payload = simulateAnswerQuestion(input);
    expect(payload).toEqual([["Opção A"]]);
    expect(simulateDisplayValue(input)).toBe("Opção A");
  });

  it("CASO B — pergunta nativa multi-select", () => {
    const input = [["Opção A", "Opção C"]];
    const payload = simulateAnswerQuestion(input);
    expect(payload).toEqual([["Opção A", "Opção C"]]);
    expect(simulateDisplayValue(input)).toBe("Opção A, Opção C");
  });

  it("CASO C — três perguntas", () => {
    const input = [
      ["Resposta 1"],
      ["Resposta 2"],
      ["Resposta 3"]
    ];
    const payload = simulateAnswerQuestion(input);
    expect(payload).toEqual([
      ["Resposta 1"],
      ["Resposta 2"],
      ["Resposta 3"]
    ]);
    expect(simulateDisplayValue(input)).toBe("Resposta 1 | Resposta 2 | Resposta 3");
  });

  it("CASO D — fluxo legado string", () => {
    const input = "Resposta antiga";
    const payload = simulateAnswerQuestion(input);
    expect(payload).toEqual(["Resposta antiga"]);
    expect(simulateDisplayValue(input)).toBe("Resposta antiga");
  });

  it("CASO E — não acontece triplo aninhamento", () => {
    const input = [["Opção A"]];
    const payload = simulateAnswerQuestion(input);
    expect(payload).not.toEqual([[["Opção A"]]]);
  });
});
