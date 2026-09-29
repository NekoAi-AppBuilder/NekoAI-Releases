import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Reproducer Test: Session Isolation & History Leaks between Projects
 * Simula a criação de sessões do OpenCode e fluxo de troca de projeto para verificar
 * se o contexto do Projeto A (ex: "PROJETO_A_UNIQUE_8472") vaza para a sessão do Projeto B.
 */

interface MockSession {
  sessionId: string;
  projectPath: string;
  history: Array<{ role: string; text: string }>;
}

class MockOpenCodeServer {
  private sessions = new Map<string, MockSession>();

  public createSession(projectPath: string): string {
    const sessionId = `ses_${Math.random().toString(36).slice(2, 9)}`;
    this.sessions.set(sessionId, {
      sessionId,
      projectPath,
      history: []
    });
    return sessionId;
  }

  public prompt(sessionId: string, text: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Sessão não encontrada");

    session.history.push({ role: "user", text });

    // Verifica se a história da própria sessão contém o token de teste
    const hasProjectATokenInSession = session.history.some(h => h.text.includes("PROJETO_A_UNIQUE_8472"));

    let reply = "";
    if (text.includes("Qual foi o identificador único que informei no projeto anterior?")) {
      if (hasProjectATokenInSession) {
        reply = "O identificador informado no projeto anterior foi PROJETO_A_UNIQUE_8472.";
      } else {
        reply = "Não possuo informações ou histórico de projetos anteriores nesta sessão.";
      }
    } else {
      reply = `Entendido. Registrado: ${text}`;
    }

    session.history.push({ role: "assistant", text: reply });
    return reply;
  }

  public getSession(sessionId: string): MockSession | undefined {
    return this.sessions.get(sessionId);
  }
}

test("1. Troca de projeto com nova sessionId -> ISOLAMENTO TOTAL (Contexto A não chega a B)", () => {
  const server = new MockOpenCodeServer();

  // 1. Abrir Projeto A
  const pathProjA = "C:/Projects/ProjectA";
  const sessionA = server.createSession(pathProjA);
  assert.notEqual(sessionA, "");

  // 2. Prompt no Projeto A com token exclusivo
  const tokenA = "PROJETO_A_UNIQUE_8472";
  const replyA = server.prompt(sessionA, `Guardar chave de teste: ${tokenA}`);
  assert.match(replyA, /PROJETO_A_UNIQUE_8472/);

  // 3. Trocar para Projeto B -> Gera nova sessionId
  const pathProjB = "C:/Projects/ProjectB";
  const sessionB = server.createSession(pathProjB);

  // Verificação 1: sessionB é estritamente diferente de sessionA
  assert.notEqual(sessionA, sessionB, "A sessionId do Projeto B deve ser diferente da do Projeto A");

  // Verificação 2: projectPath associado a B é correto
  const projBSessionObj = server.getSession(sessionB);
  assert.equal(projBSessionObj?.projectPath, pathProjB);

  // 4. Pergunta no Projeto B sobre o projeto anterior
  const replyB = server.prompt(sessionB, "Qual foi o identificador único que informei no projeto anterior?");

  // Verificação 3: O contexto do Projeto A NÃO vaza para o Projeto B
  assert.doesNotMatch(replyB, /PROJETO_A_UNIQUE_8472/);
  assert.match(replyB, /Não possuo informações/);
});

test("2. Reutilização acidental da mesma sessionId -> CAUSA VAZAMENTO (Cenário de regressão)", () => {
  const server = new MockOpenCodeServer();

  // Abrir Projeto A
  const sessionShared = server.createSession("C:/Projects/ProjectA");
  server.prompt(sessionShared, "Guardar chave de teste: PROJETO_A_UNIQUE_8472");

  // Se por erro a UI reutilizar sessionShared no Projeto B sem resetar sessionId:
  const leakedReply = server.prompt(sessionShared, "Qual foi o identificador único que informei no projeto anterior?");

  assert.match(leakedReply, /PROJETO_A_UNIQUE_8472/, "Reutilizar a mesma sessionId faz a memória do Projeto A vazar para o Projeto B!");
});
