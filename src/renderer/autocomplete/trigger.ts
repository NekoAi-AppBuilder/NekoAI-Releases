import type { TriggerMatch } from "./types.ts";

/**
 * Detecta se a posição atual do cursor no textarea representa um gatilho de autocomplete válido.
 * 
 * Regras:
 * 1. O gatilho ('/' ou '@') deve estar no início da linha/texto ou precedido imediatamente por espaço em branco.
 * 2. Não deve conter espaços entre o gatilho e a posição atual do cursor.
 * 3. Não dispara em e-mails (ex: email@example.com) nem em caminhos/URLs (ex: https://... ou a/b).
 */
export function detectAutocompleteTrigger(text: string, cursorIndex: number): TriggerMatch | null {
  if (cursorIndex < 0 || cursorIndex > text.length) return null;

  // Texto até a posição do cursor
  const textBeforeCursor = text.slice(0, cursorIndex);

  // Encontra o último delimitador de espaço em branco antes do cursor
  const lastSpace = Math.max(
    textBeforeCursor.lastIndexOf(" "),
    textBeforeCursor.lastIndexOf("\n"),
    textBeforeCursor.lastIndexOf("\t"),
    textBeforeCursor.lastIndexOf("\r")
  );

  const tokenStart = lastSpace === -1 ? 0 : lastSpace + 1;
  const token = textBeforeCursor.slice(tokenStart);

  if (!token) return null;

  // Verifica se o token começa com '/'
  if (token.startsWith("/")) {
    const query = token.slice(1);
    // Se houver mais de uma barra no mesmo token (ex: // ou a/b), ignora
    if (query.includes("/")) return null;

    return {
      mode: "commands",
      query,
      triggerIndex: tokenStart,
      cursorIndex
    };
  }

  // Verifica se o token começa com '@'
  if (token.startsWith("@")) {
    const query = token.slice(1);
    // Se houver outro @ no token, ignora
    if (query.includes("@")) return null;

    return {
      mode: "contexts",
      query,
      triggerIndex: tokenStart,
      cursorIndex
    };
  }

  return null;
}

/**
 * Aplica a seleção de um comando ou contexto substituindo o token atual no texto.
 * Preserva qualquer texto antes e depois do token e garante um espaço final para continuar digitando.
 */
export function applyAutocompleteSelection(
  text: string,
  triggerMatch: { triggerIndex: number; cursorIndex: number },
  insertionText: string
): { newText: string; newCursor: number } {
  const textBefore = text.slice(0, triggerMatch.triggerIndex);
  const textAfter = text.slice(triggerMatch.cursorIndex);

  // Garante um espaço após o token para facilidade de digitação contínua, sem duplicar espaço se já houver
  const trailingSpace = textAfter.startsWith(" ") ? "" : " ";
  const replacement = `${insertionText}${trailingSpace}`;

  const newText = `${textBefore}${replacement}${textAfter}`;
  const newCursor = textBefore.length + replacement.length;

  return { newText, newCursor };
}
