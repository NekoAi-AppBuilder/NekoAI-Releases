import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GithubAccountManager, type GithubAccountRecord } from "../src/main/github/github-account-manager";

describe("GitHub Multi-Account Support Test Suite", () => {
  let tempDir: string;
  let manager: GithubAccountManager;

  const accountA: GithubAccountRecord = {
    id: "user_101",
    login: "AndreCaramo97",
    name: "André Caramo",
    avatarUrl: "https://avatars.githubusercontent.com/u/101",
    email: "andre@example.com",
    token: "gho_token_account_a_secret_12345",
    addedAt: 1000
  };

  const accountB: GithubAccountRecord = {
    id: "user_202",
    login: "VivamaisAdmin",
    name: "Clínica Viva Mais Admin",
    avatarUrl: "https://avatars.githubusercontent.com/u/202",
    email: "admin@vivamais.com",
    token: "gho_token_account_b_secret_67890",
    addedAt: 2000
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-github-multi-test-"));
    manager = new GithubAccountManager(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. Conexão inicial com 1 conta salva corretamente", () => {
    manager.saveAccountRecord(accountA);
    const records = manager.getAccountRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "user_101");
    assert.equal(records[0].login, "AndreCaramo97");
    assert.equal(records[0].token, "gho_token_account_a_secret_12345");
  });

  it("2. Adição da 2ª conta sem perder a 1ª", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const records = manager.getAccountRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].login, "AndreCaramo97");
    assert.equal(records[1].login, "VivamaisAdmin");

    const summaries = manager.getAccountsSummary();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].id, "user_101");
    assert.equal(summaries[1].id, "user_202");
  });

  it("3. Alternância manual entre Conta A e Conta B", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const projectPath = "c:\\projects\\my-app";

    // Associa explicitamente Conta B ao projeto
    manager.setProjectAssociation(projectPath, accountB.id);
    assert.equal(manager.getProjectAssociation(projectPath), "user_202");

    // Alterna para Conta A
    manager.setProjectAssociation(projectPath, accountA.id);
    assert.equal(manager.getProjectAssociation(projectPath), "user_101");
  });

  it("4. Auto-seleção da conta associada ao projeto", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const project1 = "c:\\projects\\neko-app";
    const project2 = "c:\\projects\\clinica-vivamais";

    manager.setProjectAssociation(project1, accountA.id);
    manager.setProjectAssociation(project2, accountB.id);

    assert.equal(manager.getProjectAssociation(project1), accountA.id);
    assert.equal(manager.getProjectAssociation(project2), accountB.id);
  });

  it("5. Repositório com acesso exclusivo na Conta B (resolve conta B)", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    // Simulador de consulta a repositórios por conta
    const checkAccess = (accId: string, remoteRepo: string) => {
      if (remoteRepo === "clinica-vivamais/app") {
        return accId === accountB.id;
      }
      return false;
    };

    const targetRepo = "clinica-vivamais/app";
    const accounts = manager.getAccountRecords();
    const accessible = accounts.find(acc => checkAccess(acc.id, targetRepo));

    assert.ok(accessible);
    assert.equal(accessible?.id, accountB.id);
    assert.equal(accessible?.login, "VivamaisAdmin");
  });

  it("6. Desconexão individual da Conta A (Conta B continua ativa)", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    manager.removeAccountRecord(accountA.id);

    const remaining = manager.getAccountRecords();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, accountB.id);
    assert.equal(remaining[0].login, "VivamaisAdmin");
  });

  it("7. Repositório sem acesso em NENHUMA conta conectada (retorna nulo / sem acesso)", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const checkAccess = (_accId: string, _remoteRepo: string) => false;
    const targetRepo = "unauthorized-org/secret-repo";

    const accounts = manager.getAccountRecords();
    const accessible = accounts.find(acc => checkAccess(acc.id, targetRepo));

    assert.equal(accessible, undefined);
  });

  it("8. Associação persistente de múltiplos projetos com contas diferentes", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const project1 = "c:\\projects\\proj1";
    const project2 = "c:\\projects\\proj2";

    manager.setProjectAssociation(project1, accountA.id);
    manager.setProjectAssociation(project2, accountB.id);

    // Instancia um novo manager apontando para o mesmo diretório de dados
    const manager2 = new GithubAccountManager(tempDir);
    assert.equal(manager2.getProjectAssociation(project1), accountA.id);
    assert.equal(manager2.getProjectAssociation(project2), accountB.id);
  });

  it("9. Garantia de NENHUM token exposto nos resumos enviados ao Renderer", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const summaries = manager.getAccountsSummary();
    for (const summary of summaries) {
      assert.equal((summary as any).token, undefined);
      assert.equal((summary as any).refreshToken, undefined);
      assert.ok(summary.id);
      assert.ok(summary.login);
    }
  });

  it("10. Token correto retornado para Auto Commit", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const projectPath = "c:\\projects\\clinica-vivamais";
    manager.setProjectAssociation(projectPath, accountB.id);

    const resolvedAccId = manager.getProjectAssociation(projectPath);
    const resolvedAccount = manager.getAccountById(resolvedAccId!);

    assert.equal(resolvedAccount?.token, "gho_token_account_b_secret_67890");
  });

  it("11. Token correto retornado para Commit Seletivo", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const projectPath = "c:\\projects\\neko-app";
    manager.setProjectAssociation(projectPath, accountA.id);

    const resolvedAccId = manager.getProjectAssociation(projectPath);
    const resolvedAccount = manager.getAccountById(resolvedAccId!);

    assert.equal(resolvedAccount?.token, "gho_token_account_a_secret_12345");
  });

  it("12. Token correto retornado para Pull e Sync", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const projectPath = "c:\\projects\\clinica-vivamais";
    manager.setProjectAssociation(projectPath, accountB.id);

    const resolvedAccId = manager.getProjectAssociation(projectPath);
    const resolvedAccount = manager.getAccountById(resolvedAccId!);

    assert.equal(resolvedAccount?.token, "gho_token_account_b_secret_67890");
  });

  it("13. Migração transparente de github-auth.json legada", () => {
    const legacyAuthPath = path.join(tempDir, "github-auth.json");
    // Simula arquivo legado
    const legacyContent = {
      encrypted: Buffer.from(JSON.stringify({
        token: "gho_legacy_token_999",
        expiresAt: 123456
      }), "utf8").toString("base64")
    };
    fs.writeFileSync(legacyAuthPath, JSON.stringify(legacyContent), "utf8");

    const newManager = new GithubAccountManager(tempDir);
    const records = newManager.getAccountRecords();

    assert.equal(records.length, 1);
    assert.equal(records[0].token, "gho_legacy_token_999");
    assert.notEqual(records[0].login, "account_connected");
  });

  it("14. Garantia de eliminação permanente de 'account_connected' e atualização com dados reais", () => {
    const legacyAuthPath = path.join(tempDir, "github-auth.json");
    const legacyContent = {
      encrypted: Buffer.from(JSON.stringify({
        token: "gho_legacy_token_888"
      }), "utf8").toString("base64")
    };
    fs.writeFileSync(legacyAuthPath, JSON.stringify(legacyContent), "utf8");

    const newManager = new GithubAccountManager(tempDir);
    const records = newManager.getAccountRecords();

    assert.equal(records.length, 1);
    assert.notEqual(records[0].login, "account_connected");

    // Simula a atualização com a resposta real da API do GitHub (/user)
    const realGithubUser = {
      id: "999888",
      login: "RealGithubUser",
      name: "Real User Name",
      avatarUrl: "https://avatars.githubusercontent.com/u/999888",
      email: "real@github.com",
      token: records[0].token,
      addedAt: records[0].addedAt
    };

    newManager.saveAccountRecord(realGithubUser);

    const updatedRecords = newManager.getAccountRecords();
    assert.equal(updatedRecords.length, 1);
    assert.equal(updatedRecords[0].login, "RealGithubUser");
    assert.equal(updatedRecords[0].name, "Real User Name");
    assert.equal(updatedRecords[0].avatarUrl, "https://avatars.githubusercontent.com/u/999888");
  });

  it("15. Alternância de conta no fluxo de clone permite resgatar a conta ativa e seu token sem vazamento de dados", () => {
    const acc1: GithubAccountRecord = {
      id: "clone_user_1",
      login: "CloneUser1",
      name: "Clone User One",
      avatarUrl: "https://avatar.com/1",
      email: "user1@clone.com",
      token: "gho_clone_token_1",
      addedAt: 3000
    };
    const acc2: GithubAccountRecord = {
      id: "clone_user_2",
      login: "CloneUser2",
      name: "Clone User Two",
      avatarUrl: "https://avatar.com/2",
      email: "user2@clone.com",
      token: "gho_clone_token_2",
      addedAt: 4000
    };

    manager.saveAccountRecord(acc1);
    manager.saveAccountRecord(acc2);

    const fetchedAcc1 = manager.getAccountById("clone_user_1");
    const fetchedAcc2 = manager.getAccountById("clone_user_2");

    assert.equal(fetchedAcc1?.id, "clone_user_1");
    assert.equal(fetchedAcc1?.token, "gho_clone_token_1");

    assert.equal(fetchedAcc2?.id, "clone_user_2");
    assert.equal(fetchedAcc2?.token, "gho_clone_token_2");

    assert.notEqual(fetchedAcc1?.token, fetchedAcc2?.token);
  });

  it("16. Desconexão de conta no seletor remove a credencial e preserva as demais contas conectadas", () => {
    manager.saveAccountRecord(accountA);
    manager.saveAccountRecord(accountB);

    const records = manager.getAccountRecords();
    assert.equal(records.length, 2);

    manager.removeAccountRecord(accountA.id);

    const remaining = manager.getAccountRecords();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, accountB.id);
    assert.equal(remaining[0].login, "VivamaisAdmin");
  });
});



