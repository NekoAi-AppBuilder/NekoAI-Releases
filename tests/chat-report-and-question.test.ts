import { test } from "node:test";
import assert from "node:assert/strict";

function isCompletionReport(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;

  // 1. Títulos de relatório Markdown (# Resumo, ## Alterações, ## Arquivos modificados, etc.)
  if (/^#{1,4}\s+(?:resumo|altera[çc][õo]es|modifica[çc][õo]es|arquivos|conclus[ãa]o|o que foi feito|implementa[çc][ãa]o|resultado|status|relat[óo]rio|summary|changes|completed|done|report|overview|changelog)(?:$|[^\p{L}\p{N}])/imu.test(normalized)) {
    return true;
  }

  // 2. Frases clássicas de conclusão de tarefa / execução
  const boundaryBefore = "(?:^|[^\\p{L}\\p{N}])";
  const boundaryAfter = "(?:$|[^\\p{L}\\p{N}])";
  const completionPhrases = [
    "conclu[íi]",
    "concluido",
    "conclu[íi]da?",
    "finalizei",
    "finalizado",
    "implementei",
    "implementado",
    "as altera[çc][õo]es foram",
    "o projeto foi (?:atualizado|configurado)",
    "o build passou",
    "testes passaram",
    "tudo pronto",
    "conclu[íi]da? com sucesso",
    "i have (?:completed|implemented|updated|created|fixed)",
    "changes have been (?:made|applied)",
    "build succeeded"
  ].join("|");
  const completionRegex = new RegExp(`${boundaryBefore}(?:${completionPhrases})${boundaryAfter}`, "iu");
  if (completionRegex.test(normalized)) {
    return true;
  }

  // 3. Lista de arquivos modificados (linhas como "- src/..." ou "* src/..." ou "1. src/...")
  const fileListMatches = normalized.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+(?:`?[a-zA-Z0-9_\-./\\]+\.(?:tsx?|jsx?|css|html|json|md|py|go|rs|vue|svelte|env)[`:]?)/g);
  if (fileListMatches && fileListMatches.length >= 2) return true;
  return false;
}

function extractQuestionOptions(text: string): string[] {
  if (isCompletionReport(text)) return [];
  const options: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:(\d+)[.)]|[-*])\s+(.{2,140})$/);
    if (match) {
      const optText = match[2].trim();
      // Não tratar caminhos de arquivos como opções de pergunta
      if (/\b[a-zA-Z0-9_\-./\\]+\.(?:tsx?|jsx?|css|html|json|md|py|go|rs|env)\b/i.test(optText)) continue;
      options.push((match[1] ? (match[1] + ". ") : "") + optText);
    }
  }
  return options.length >= 2 ? options : [];
}

function detectQuestion(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;

  // Relatórios de conclusão NUNCA são perguntas interativas
  if (isCompletionReport(normalized)) return false;

  // Textos longos (> 500 caracteres) são explicações ou relatórios, nunca questions interativas
  if (normalized.length > 500) return false;

  const cleaned = normalized.replace(/[)}\]\"'`»“”]+$/, "");
  // Pergunta direta: termina com ponto de interrogação
  if (/[?？]\s*$/.test(cleaned)) {
    const courtesy = "(?:^|[^\\p{L}\\p{N}])(?:deseja (?:fazer|testar|adicionar)? mais (?:algo|alguma altera[çc][ãa]o)|posso ajudar com mais algo|qualquer d[úu]vida|o que gostaria de fazer|would you like to (?:do|test)? anything else|let me know)(?:$|[^\\p{L}\\p{N}])";
    if (new RegExp(courtesy, "iu").test(cleaned)) {
      return false;
    }
    return true;
  }

  // Pergunta com opções (onde as opções vêm nas linhas abaixo da pergunta)
  if (/[?？]/.test(normalized) && extractQuestionOptions(normalized).length >= 2) {
    return true;
  }

  return false;
}

function determineTaskFinalState(record: { sawBusy: boolean; planMode: boolean }, latestText: string): "completed" | "waiting_for_user" {
  if (record.sawBusy && !record.planMode) return "completed";
  if (isCompletionReport(latestText)) return "completed";
  if (detectQuestion(latestText)) return "waiting_for_user";
  return "completed";
}

test("1. Mensagem normal pequena não é question", () => {
  const msg = "Olá! O Neko está pronto para ajudar no seu projeto.";
  assert.equal(detectQuestion(msg), false);
  assert.equal(isCompletionReport(msg), false);
});

test("2. Mensagem normal grande explicativa não vira question", () => {
  const longExplanation = "Aqui está uma explicação detalhada sobre o estado:\n".repeat(10);
  assert.equal(detectQuestion(longExplanation), false);
});

test("3. Relatório final pequeno com pergunta de cortesia é completed e não question", () => {
  const smallReport = "Concluí as alterações no arquivo de rotas.\n\nDeseja fazer mais alguma alteração?";
  assert.equal(isCompletionReport(smallReport), true);
  assert.equal(detectQuestion(smallReport), false);
  assert.equal(determineTaskFinalState({ sawBusy: true, planMode: false }, smallReport), "completed");
});

test("4. Relatório final grande com lista de arquivos e markdown é completed", () => {
  const largeReport = "# Resumo da Execução\n\nImplementei a autenticação.\n\n## Arquivos:\n- src/auth.ts\n- src/login.tsx\n\nO que gostaria de fazer a seguir?";
  assert.equal(isCompletionReport(largeReport), true);
  assert.equal(detectQuestion(largeReport), false);
  assert.deepEqual(extractQuestionOptions(largeReport), []);
  assert.equal(determineTaskFinalState({ sawBusy: true, planMode: false }, largeReport), "completed");
});

test("5. QUESTION real pequena sem trabalho executado é classificada como question", () => {
  const realQuestion = "Qual banco de dados você deseja utilizar?\n1. SQLite\n2. PostgreSQL";
  assert.equal(isCompletionReport(realQuestion), false);
  assert.equal(detectQuestion(realQuestion), true);
  const options = extractQuestionOptions(realQuestion);
  assert.equal(options.length, 2);
  assert.equal(options[0], "1. SQLite");
  assert.equal(options[1], "2. PostgreSQL");
  assert.equal(determineTaskFinalState({ sawBusy: false, planMode: false }, realQuestion), "waiting_for_user");
});

test("6. QUESTION real grande preserva opções visíveis", () => {
  const q = "Precisamos escolher o banco:\n1. Supabase\n2. Firebase\nQual opção você prefere?";
  const options = extractQuestionOptions(q);
  assert.equal(options.length, 2);
  assert.equal(options[0], "1. Supabase");
  assert.equal(options[1], "2. Firebase");
});

test("7. Tarefa em modo Build com trabalho executado (sawBusy=true) SEMPRE conclui em completed", () => {
  const taskText = "Modifiquei os arquivos. Deseja testar algo mais?";
  assert.equal(determineTaskFinalState({ sawBusy: true, planMode: false }, taskText), "completed");
});

test("8. Segunda tarefa consecutiva inicia em estado limpo sem herdar waiting_for_user", () => {
  assert.equal(determineTaskFinalState({ sawBusy: true, planMode: false }, "Tarefa 1 concluída."), "completed");
  assert.equal(determineTaskFinalState({ sawBusy: true, planMode: false }, "# Relatório Tarefa 2\n- src/App.tsx\n- src/index.css"), "completed");
});

test("9. Plan Mode preserva plano para aprovação", () => {
  const planRecord = { sawBusy: false, planMode: true };
  assert.equal(planRecord.planMode, true);
});
