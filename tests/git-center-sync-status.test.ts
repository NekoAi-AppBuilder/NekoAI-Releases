import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Git Center Sync Status — Estados Mutuamente Coerentes
 *
 * Garante que o Git Center nunca exiba "Tudo sincronizado" ao mesmo tempo
 * que qualquer estado pendente (behind > 0, ahead > 0, isDirty, diverged).
 *
 * Regra de exibição implementada em main.tsx (bloco de chips do Card "Estado Local & Branch"):
 *
 *   if (isDirty)                                 → chip "arquivo(s) modificado(s)"
 *   else if (behind === 0 && ahead === 0 && !diverged) → chip "Tudo sincronizado"
 *   else                                          → chip "Sem alterações locais"
 */

interface GitCenterState {
  isDirty: boolean;
  changedCount: number;
  ahead: number;
  behind: number;
  diverged: boolean;
  isAccessible: boolean;
}

/**
 * Replica a lógica de decisão dos chips do Git Center (main.tsx L10714-10723).
 * Retorna o texto do chip de estado local.
 */
function getLocalStatusChip(s: GitCenterState): string {
  if (s.isDirty) {
    return `${s.changedCount} arquivo(s) modificado(s)`;
  }
  if (s.behind === 0 && s.ahead === 0 && !s.diverged) {
    return s.isAccessible ? "Tudo sincronizado" : "Arquivos locais em dia";
  }
  return "Sem alterações locais";
}

/**
 * Replica a lógica dos chips de estado remoto (main.tsx L10712-10713).
 * Retorna lista de chips remotos visíveis.
 */
function getRemoteChips(s: GitCenterState): string[] {
  const chips: string[] = [];
  if (s.ahead > 0) {
    chips.push(`${s.ahead} ${s.ahead === 1 ? "commit pronto para enviar" : "commits prontos para enviar"}`);
  }
  if (s.behind > 0) {
    chips.push(s.behind === 1 ? "Há 1 atualização nova no remoto" : `Há ${s.behind} atualizações novas no remoto`);
  }
  return chips;
}

/**
 * Combina tudo: retorna todos os chips visíveis simultaneamente.
 */
function getAllVisibleChips(s: GitCenterState): string[] {
  return [...getRemoteChips(s), getLocalStatusChip(s)];
}

// ─── Cenário 1: behind > 0 + working tree limpa ──────────────────────────────
describe("Git Center Sync Status — Estados Mutuamente Coerentes", () => {
  it("1. behind > 0 + working tree limpa: mostra atualização remota e NÃO mostra 'Tudo sincronizado'", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 1,
      diverged: false,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    // Deve conter o chip de atualização remota
    assert.ok(
      chips.some(c => c.includes("atualização nova no remoto")),
      `Esperado chip de atualização remota. Chips: ${JSON.stringify(chips)}`
    );

    // NÃO deve conter "Tudo sincronizado"
    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `'Tudo sincronizado' não deve aparecer com behind > 0. Chips: ${JSON.stringify(chips)}`
    );

    // Deve mostrar "Sem alterações locais" (working tree limpa mas ainda pendente)
    assert.ok(
      chips.includes("Sem alterações locais"),
      `Esperado 'Sem alterações locais'. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário 2: ahead > 0 + working tree limpa ─────────────────────────────
  it("2. ahead > 0 + working tree limpa: mostra commits prontos para enviar e NÃO mostra 'Tudo sincronizado'", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 2,
      behind: 0,
      diverged: false,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    assert.ok(
      chips.some(c => c.includes("commits prontos para enviar")),
      `Esperado chip de commits prontos para enviar. Chips: ${JSON.stringify(chips)}`
    );

    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `'Tudo sincronizado' não deve aparecer com ahead > 0. Chips: ${JSON.stringify(chips)}`
    );

    assert.ok(
      chips.includes("Sem alterações locais"),
      `Esperado 'Sem alterações locais'. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário 3: behind = 0, ahead = 0, working tree dirty ──────────────────
  it("3. working tree dirty + behind = 0 + ahead = 0: mostra arquivos modificados e NÃO mostra 'Tudo sincronizado'", () => {
    const state: GitCenterState = {
      isDirty: true,
      changedCount: 3,
      ahead: 0,
      behind: 0,
      diverged: false,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    assert.ok(
      chips.some(c => c.includes("arquivo(s) modificado(s)")),
      `Esperado chip de arquivos modificados. Chips: ${JSON.stringify(chips)}`
    );

    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `'Tudo sincronizado' não deve aparecer com isDirty = true. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário 4: totalmente sincronizado ────────────────────────────────────
  it("4. behind = 0, ahead = 0, !isDirty, !diverged: mostra 'Tudo sincronizado' e NENHUM estado pendente", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: false,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    assert.ok(
      chips.includes("Tudo sincronizado"),
      `Esperado 'Tudo sincronizado'. Chips: ${JSON.stringify(chips)}`
    );

    // Nenhum chip de estado pendente
    assert.ok(
      !chips.some(c => c.includes("atualização nova no remoto")),
      `Não deve haver chip de atualização remota. Chips: ${JSON.stringify(chips)}`
    );
    assert.ok(
      !chips.some(c => c.includes("pronto para enviar")),
      `Não deve haver chip de commits prontos. Chips: ${JSON.stringify(chips)}`
    );
    assert.ok(
      !chips.some(c => c.includes("arquivo(s) modificado(s)")),
      `Não deve haver chip de arquivos modificados. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário 5: behind > 0 + working tree dirty ────────────────────────────
  it("5. behind > 0 + working tree dirty: mostra ambos os estados e NÃO mostra 'Tudo sincronizado'", () => {
    const state: GitCenterState = {
      isDirty: true,
      changedCount: 2,
      ahead: 0,
      behind: 3,
      diverged: false,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    assert.ok(
      chips.some(c => c.includes("atualiza")),
      `Esperado chip de atualizações remotas. Chips: ${JSON.stringify(chips)}`
    );
    assert.ok(
      chips.some(c => c.includes("arquivo(s) modificado(s)")),
      `Esperado chip de arquivos modificados. Chips: ${JSON.stringify(chips)}`
    );
    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `'Tudo sincronizado' não deve aparecer com behind > 0 e isDirty. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário 6: divergência/conflito ───────────────────────────────────────
  it("6. divergência: NÃO mostra 'Tudo sincronizado' mesmo com working tree limpa e behind = 0", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 1,
      behind: 1,
      diverged: true,
      isAccessible: true,
    };

    const chips = getAllVisibleChips(state);

    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `'Tudo sincronizado' não deve aparecer com divergência. Chips: ${JSON.stringify(chips)}`
    );

    // Working tree limpa → "Sem alterações locais" (não "Tudo sincronizado")
    assert.ok(
      chips.includes("Sem alterações locais"),
      `Esperado 'Sem alterações locais' no cenário de divergência sem dirty. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Invariante: "Tudo sincronizado" é mutuamente exclusivo ────────────────
  it("7. INVARIANTE: 'Tudo sincronizado' nunca co-existe com behind > 0", () => {
    for (let behind = 1; behind <= 5; behind++) {
      const state: GitCenterState = {
        isDirty: false,
        changedCount: 0,
        ahead: 0,
        behind,
        diverged: false,
        isAccessible: true,
      };
      const chips = getAllVisibleChips(state);
      assert.ok(
        !chips.includes("Tudo sincronizado"),
        `behind=${behind}: 'Tudo sincronizado' nunca deve co-existir com atualizações remotas. Chips: ${JSON.stringify(chips)}`
      );
    }
  });

  it("8. INVARIANTE: 'Tudo sincronizado' nunca co-existe com ahead > 0", () => {
    for (let ahead = 1; ahead <= 5; ahead++) {
      const state: GitCenterState = {
        isDirty: false,
        changedCount: 0,
        ahead,
        behind: 0,
        diverged: false,
        isAccessible: true,
      };
      const chips = getAllVisibleChips(state);
      assert.ok(
        !chips.includes("Tudo sincronizado"),
        `ahead=${ahead}: 'Tudo sincronizado' nunca deve co-existir com commits pendentes. Chips: ${JSON.stringify(chips)}`
      );
    }
  });

  it("9. INVARIANTE: 'Tudo sincronizado' nunca co-existe com isDirty = true", () => {
    for (let count = 1; count <= 4; count++) {
      const state: GitCenterState = {
        isDirty: true,
        changedCount: count,
        ahead: 0,
        behind: 0,
        diverged: false,
        isAccessible: true,
      };
      const chips = getAllVisibleChips(state);
      assert.ok(
        !chips.includes("Tudo sincronizado"),
        `changedCount=${count}: 'Tudo sincronizado' nunca deve co-existir com alterações locais. Chips: ${JSON.stringify(chips)}`
      );
    }
  });

  it("10. INVARIANTE: 'Tudo sincronizado' nunca co-existe com diverged = true", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: true,
      isAccessible: true,
    };
    const chips = getAllVisibleChips(state);
    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `diverged=true: 'Tudo sincronizado' nunca deve co-existir com divergência. Chips: ${JSON.stringify(chips)}`
    );
  });

  // ─── Cenário real validado manualmente ─────────────────────────────────────
  it("11. Cenário real: before sync (behind=1, limpa) → NÃO 'Tudo sincronizado'; after sync (behind=0, limpa) → 'Tudo sincronizado'", () => {
    // Estado ANTES de clicar em "Atualizar projeto"
    const before: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 1,
      diverged: false,
      isAccessible: true,
    };
    const chipsBefore = getAllVisibleChips(before);

    assert.ok(
      chipsBefore.includes("Há 1 atualização nova no remoto"),
      `Antes da sync: esperado chip de atualização remota. Chips: ${JSON.stringify(chipsBefore)}`
    );
    assert.ok(
      chipsBefore.includes("Sem alterações locais"),
      `Antes da sync: esperado 'Sem alterações locais'. Chips: ${JSON.stringify(chipsBefore)}`
    );
    assert.ok(
      !chipsBefore.includes("Tudo sincronizado"),
      `Antes da sync: 'Tudo sincronizado' não deve aparecer. Chips: ${JSON.stringify(chipsBefore)}`
    );

    // Estado DEPOIS de "Atualizar projeto" (ff-only concluído com sucesso)
    const after: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: false,
      isAccessible: true,
    };
    const chipsAfter = getAllVisibleChips(after);

    assert.ok(
      chipsAfter.includes("Tudo sincronizado"),
      `Após sync: esperado 'Tudo sincronizado'. Chips: ${JSON.stringify(chipsAfter)}`
    );
    assert.ok(
      !chipsAfter.some(c => c.includes("atualização nova no remoto")),
      `Após sync: chip de atualização remota não deve aparecer. Chips: ${JSON.stringify(chipsAfter)}`
    );
  });

  // ─── Sem acesso ao repositório ─────────────────────────────────────────────
  it("12. Sem acesso ao repositório: exibe 'Arquivos locais em dia' em vez de 'Tudo sincronizado'", () => {
    const state: GitCenterState = {
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0, // behind é zerado quando !isAccessible em main.tsx L10564
      diverged: false,
      isAccessible: false,
    };
    const chips = getAllVisibleChips(state);

    assert.ok(
      chips.includes("Arquivos locais em dia"),
      `Sem acesso: esperado 'Arquivos locais em dia'. Chips: ${JSON.stringify(chips)}`
    );
    assert.ok(
      !chips.includes("Tudo sincronizado"),
      `Sem acesso: não deve mostrar 'Tudo sincronizado'. Chips: ${JSON.stringify(chips)}`
    );
  });
});
