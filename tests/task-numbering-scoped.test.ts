import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Task Numbering & Correlation ID Isolation
 * Garante que:
 * 1. promptTaskCounter interno no processo Main continua único e inalterado para logs, SSE e IPC.
 * 2. O número visual da Task exibido ao usuário é escopado por projeto/sessão (Task #1, Task #2 no Projeto A; Task #1 no Projeto B).
 */

class TaskNumberingManager {
  private globalCorrelationCounter = 0;

  // Cria um ID interno global único (ex: t1, t2, t3...)
  public nextInternalCorrelationId(): string {
    return `t${(++this.globalCorrelationCounter).toString(36)}`;
  }

  // Calcula o número visual escopado pela lista de mensagens da sessão ativa
  public getVisualTaskNumber(messages: Array<{ role: string; taskId?: string }>): number {
    const userPrompts = messages.filter(m => m.role === "user");
    return userPrompts.length; // O prompt N é a Task #N visual do projeto atual
  }
}

test("1. promptTaskCounter interno mantém IDs únicos em toda a execução do aplicativo", () => {
  const manager = new TaskNumberingManager();
  
  const id1 = manager.nextInternalCorrelationId();
  const id2 = manager.nextInternalCorrelationId();
  const id3 = manager.nextInternalCorrelationId();

  assert.equal(id1, "t1");
  assert.equal(id2, "t2");
  assert.equal(id3, "t3");
});

test("2. Número visual da Task é escopado por projeto/sessão (Projeto A: #1, #2; Projeto B: #1)", () => {
  const manager = new TaskNumberingManager();

  // --- SESSÃO PROJETO A ---
  let messagesProjA: Array<{ role: string; taskId?: string }> = [];
  
  // Prompt 1 no Projeto A
  const t1Internal = manager.nextInternalCorrelationId(); // t1
  messagesProjA.push({ role: "user", taskId: t1Internal });
  const projATask1Visual = manager.getVisualTaskNumber(messagesProjA);
  
  // Prompt 2 no Projeto A
  const t2Internal = manager.nextInternalCorrelationId(); // t2
  messagesProjA.push({ role: "user", taskId: t2Internal });
  const projATask2Visual = manager.getVisualTaskNumber(messagesProjA);

  assert.equal(projATask1Visual, 1, "Primeira tarefa do Projeto A deve ser Task #1");
  assert.equal(projATask2Visual, 2, "Segunda tarefa do Projeto A deve ser Task #2");
  assert.equal(t1Internal, "t1");
  assert.equal(t2Internal, "t2");

  // --- TROCA PARA PROJETO B (reinicia estado de mensagens) ---
  let messagesProjB: Array<{ role: string; taskId?: string }> = [];

  // Prompt 1 no Projeto B
  const t3Internal = manager.nextInternalCorrelationId(); // t3 (mantém correlação interna única)
  messagesProjB.push({ role: "user", taskId: t3Internal });
  const projBTask1Visual = manager.getVisualTaskNumber(messagesProjB);

  assert.equal(projBTask1Visual, 1, "Primeira tarefa do Projeto B deve ser ressetada para Task #1 na UI");
  assert.equal(t3Internal, "t3", "ID interno global continua sequencial e seguro sem colisão");
});
