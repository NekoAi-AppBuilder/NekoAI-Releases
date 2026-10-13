// tests/skills-integration.test.ts
// Testes automatizados para o sistema oficial de Agent Skills no NekoAI Desktop

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";

import {
  OFFICIAL_SKILLS_CATALOG,
  SKILL_CATEGORIES,
  OFFICIAL_TOTAL_SKILLS,
  OFFICIAL_TOTAL_FILES,
  getSkillDefinition,
  type SkillDefinition
} from "../src/main/skills/skills-catalog";
import { SkillsManager } from "../src/main/skills/skills-manager";

describe("Agent Skills — Catálogo & Integridade dos Metadados", () => {
  it("deve conter exatamente 10 skills oficiais no catálogo", () => {
    expect(OFFICIAL_SKILLS_CATALOG.length).toBe(10);
    expect(OFFICIAL_TOTAL_SKILLS).toBe(10);
  });

  it("deve conter a contagem total oficial de exatamente 92 arquivos", () => {
    const totalFiles = OFFICIAL_SKILLS_CATALOG.reduce((acc, s) => acc + s.arquivos.length, 0);
    expect(totalFiles).toBe(92);
    expect(OFFICIAL_TOTAL_FILES).toBe(92);
  });

  it("deve conter as 10 skills oficiais com IDs e categorias exatas", () => {
    const expected = [
      { id: "frontend-design", nome: "Design", grupo: "aparencia", files: 2 },
      { id: "web-design-guidelines", nome: "Acessibilidade", grupo: "aparencia", files: 2 },
      { id: "seo", nome: "SEO", grupo: "crescimento", files: 3 },
      { id: "copywriting", nome: "Textos", grupo: "crescimento", files: 4 },
      { id: "cro", nome: "Conversão", grupo: "crescimento", files: 3 },
      { id: "signup", nome: "Cadastro", grupo: "crescimento", files: 2 },
      { id: "supabase-security", nome: "Segurança", grupo: "tecnico", files: 3 },
      { id: "react-best-practices", nome: "Performance", grupo: "tecnico", files: 50 },
      { id: "supabase-postgres-best-practices", nome: "Banco de dados", grupo: "tecnico", files: 18 },
      { id: "core-web-vitals", nome: "Carregamento", grupo: "tecnico", files: 5 },
    ];

    for (const exp of expected) {
      const skill = OFFICIAL_SKILLS_CATALOG.find(s => s.id === exp.id);
      expect(skill).toBeDefined();
      expect(skill?.nome).toBe(exp.nome);
      expect(skill?.grupo).toBe(exp.grupo);
      expect(skill?.arquivos.length).toBe(exp.files);
    }
  });

  it("deve validar contadores por categoria (Aparência: 2, Atrair e converter: 4, Qualidade técnica: 4)", () => {
    const aparencia = OFFICIAL_SKILLS_CATALOG.filter(s => s.grupo === "aparencia").length;
    const crescimento = OFFICIAL_SKILLS_CATALOG.filter(s => s.grupo === "crescimento").length;
    const tecnico = OFFICIAL_SKILLS_CATALOG.filter(s => s.grupo === "tecnico").length;

    expect(aparencia).toBe(2);
    expect(crescimento).toBe(4);
    expect(tecnico).toBe(4);
    expect(aparencia + crescimento + tecnico).toBe(10);
  });

  it("deve recuperar corretamente qualquer skill por ID através de getSkillDefinition", () => {
    const design = getSkillDefinition("frontend-design");
    expect(design).toBeDefined();
    expect(design?.id).toBe("frontend-design");

    const nonExistent = getSkillDefinition("unknown-skill");
    expect(nonExistent).toBeUndefined();
  });
});

describe("Agent Skills — Integridade dos Playbooks no Disco (Assets)", () => {
  const assetsDir = path.resolve(__dirname, "../src/main/skills/assets");

  it("deve ter o diretório de assets existente com todas as 10 pastas de skills", () => {
    expect(fsSync.existsSync(assetsDir)).toBe(true);

    for (const skill of OFFICIAL_SKILLS_CATALOG) {
      const skillDir = path.join(assetsDir, skill.id);
      expect(fsSync.existsSync(skillDir)).toBe(true);
      const skillMd = path.join(skillDir, "SKILL.md");
      expect(fsSync.existsSync(skillMd)).toBe(true);
    }
  });

  it("deve conter todos os 92 arquivos sem exceção, não-vazios e com conteúdo legítimo", async () => {
    let checkedCount = 0;

    for (const skill of OFFICIAL_SKILLS_CATALOG) {
      for (const relFile of skill.arquivos) {
        const fullPath = path.join(assetsDir, skill.id, relFile);
        expect(fsSync.existsSync(fullPath)).toBe(true);

        const content = await fs.readFile(fullPath, "utf8");
        expect(content.length).toBeGreaterThan(10);
        // Garantir que não seja placeholder
        expect(content.includes("TODO: write playbook")).toBe(false);
        expect(content.includes("MOCK PLAYBOOK")).toBe(false);
        checkedCount++;
      }
    }

    expect(checkedCount).toBe(92);
  });

  it("deve validar o catálogo através do método validateCatalogIntegrity() do SkillsManager", () => {
    const manager = new SkillsManager();
    const result = manager.validateCatalogIntegrity();
    expect(result.valid).toBe(true);
    expect(result.skillsCount).toBe(10);
    expect(result.totalFilesFound).toBe(92);
    expect(result.totalFilesExpected).toBe(92);
    expect(result.errors.length).toBe(0);
  });
});

describe("Agent Skills — Instalação, Remoção e Execução no Projeto", () => {
  let tempDir: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-skills-test-"));
    manager = new SkillsManager();
    manager.setProject(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("deve reportar 0 instaladas e 10 disponíveis em um projeto limpo", async () => {
    const status = await manager.getStatus(tempDir);
    expect(status.totalCount).toBe(10);
    expect(status.installedCount).toBe(0);
    expect(status.skills.every(s => !s.installed)).toBe(true);
  });

  it("deve instalar com sucesso a skill Design (2 arquivos)", async () => {
    const installRes = await manager.installSkill("frontend-design", tempDir);
    expect(installRes.success).toBe(true);
    expect(installRes.filesCopied).toBe(2);

    // Verificar se os arquivos foram criados no diretório do projeto
    const skillRoot = path.join(tempDir, ".agents", "skills", "frontend-design");
    expect(fsSync.existsSync(path.join(skillRoot, "SKILL.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(skillRoot, "LICENSE.txt"))).toBe(true);

    // Verificar novo status
    const status = await manager.getStatus(tempDir);
    expect(status.installedCount).toBe(1);
    const designStatus = status.skills.find(s => s.id === "frontend-design");
    expect(designStatus?.installed).toBe(true);
    expect(designStatus?.incomplete).toBe(false);
  });

  it("deve instalar com sucesso a skill Performance (50 arquivos em subdiretórios)", async () => {
    const installRes = await manager.installSkill("react-best-practices", tempDir);
    expect(installRes.success).toBe(true);
    expect(installRes.filesCopied).toBe(50);

    const rulesDir = path.join(tempDir, ".agents", "skills", "react-best-practices", "rules");
    expect(fsSync.existsSync(rulesDir)).toBe(true);

    const status = await manager.getStatus(tempDir);
    expect(status.installedCount).toBe(1);
    const perfStatus = status.skills.find(s => s.id === "react-best-practices");
    expect(perfStatus?.installed).toBe(true);
  });

  it("deve detectar skill incompleta quando um arquivo for removido manualmente", async () => {
    await manager.installSkill("frontend-design", tempDir);
    const licFile = path.join(tempDir, ".agents", "skills", "frontend-design", "LICENSE.txt");
    await fs.unlink(licFile);

    const status = await manager.getStatus(tempDir);
    const designStatus = status.skills.find(s => s.id === "frontend-design");
    expect(designStatus?.installed).toBe(false);
    expect(designStatus?.incomplete).toBe(true);
  });

  it("deve remover skill de forma limpa e segura", async () => {
    await manager.installSkill("frontend-design", tempDir);
    await manager.installSkill("seo", tempDir);

    let status = await manager.getStatus(tempDir);
    expect(status.installedCount).toBe(2);

    const removeRes = await manager.removeSkill("frontend-design", tempDir);
    expect(removeRes.success).toBe(true);

    const designDir = path.join(tempDir, ".agents", "skills", "frontend-design");
    expect(fsSync.existsSync(designDir)).toBe(false);

    // SEO deve continuar intacto
    const seoDir = path.join(tempDir, ".agents", "skills", "seo");
    expect(fsSync.existsSync(seoDir)).toBe(true);

    status = await manager.getStatus(tempDir);
    expect(status.installedCount).toBe(1);
    expect(status.skills.find(s => s.id === "seo")?.installed).toBe(true);
    expect(status.skills.find(s => s.id === "frontend-design")?.installed).toBe(false);
  });

  it("deve retornar o prompt oficial de execução para todas as 10 skills", async () => {
    for (const skill of OFFICIAL_SKILLS_CATALOG) {
      const promptRes = manager.getExecutionPrompt(skill.id);
      expect(promptRes.prompt).toBeDefined();
      expect(promptRes.prompt.length).toBeGreaterThan(30);
      expect(promptRes.prompt.includes(`.agents/skills/${skill.id}/SKILL.md`)).toBe(true);
    }
  });

  it("deve prevenir ataques de Directory Traversal em install e remove", async () => {
    const maliciousIds = ["../escape", "../../etc/passwd", "frontend-design/../../../secret", ""];

    for (const id of maliciousIds) {
      expect(manager.installSkill(id, tempDir)).rejects.toThrow();
      expect(manager.removeSkill(id, tempDir)).rejects.toThrow();
    }
  });

  it("deve garantir isolamento entre múltiplos projetos", async () => {
    const tempDirB = await fs.mkdtemp(path.join(os.tmpdir(), "neko-skills-project-b-"));
    try {
      await manager.installSkill("signup", tempDir);

      const statusA = await manager.getStatus(tempDir);
      const statusB = await manager.getStatus(tempDirB);

      expect(statusA.installedCount).toBe(1);
      expect(statusB.installedCount).toBe(0);
    } finally {
      await fs.rm(tempDirB, { recursive: true, force: true });
    }
  });
});

describe("Agent Skills — Resiliência do Painel, Filtros e Fonte de Dados dos Cards", () => {
  it("deve mapear os 10 cards a partir do catálogo oficial mesmo se skillsState for nulo ou falhar", () => {
    // Simula renderização com skillsState nulo (ex: antes da resposta IPC ou se IPC falhar)
    const skillsState = null;
    const installedStatusMap = new Map();
    const allSkills = OFFICIAL_SKILLS_CATALOG.map(def => {
      const live = installedStatusMap.get(def.id);
      return {
        id: def.id,
        nome: def.nome,
        grupo: def.grupo,
        installed: live ? Boolean(live.installed) : false
      };
    });

    expect(allSkills.length).toBe(10);
    expect(allSkills.every(s => !s.installed)).toBe(true);
    // Todos os 10 nomes esperados devem estar presentes
    const names = allSkills.map(s => s.nome);
    expect(names).toContain("Design");
    expect(names).toContain("Acessibilidade");
    expect(names).toContain("SEO");
    expect(names).toContain("Textos");
    expect(names).toContain("Conversão");
    expect(names).toContain("Cadastro");
    expect(names).toContain("Segurança");
    expect(names).toContain("Performance");
    expect(names).toContain("Banco de dados");
    expect(names).toContain("Carregamento");
  });

  it("deve filtrar rigorosamente os cards por categoria", () => {
    const allSkills = OFFICIAL_SKILLS_CATALOG;

    // Filtro Todos: exatamente 10
    const todos = allSkills;
    expect(todos.length).toBe(10);

    // Filtro Aparência: exatamente 2 (Design e Acessibilidade)
    const aparencia = allSkills.filter(s => s.grupo === "aparencia");
    expect(aparencia.length).toBe(2);
    expect(aparencia.map(s => s.nome).sort()).toEqual(["Acessibilidade", "Design"].sort());

    // Filtro Atrair e converter: exatamente 4 (SEO, Textos, Conversão, Cadastro)
    const crescimento = allSkills.filter(s => s.grupo === "crescimento");
    expect(crescimento.length).toBe(4);
    expect(crescimento.map(s => s.nome).sort()).toEqual(["Cadastro", "Conversão", "SEO", "Textos"].sort());

    // Filtro Qualidade técnica: exatamente 4 (Segurança, Performance, Banco de dados, Carregamento)
    const tecnico = allSkills.filter(s => s.grupo === "tecnico");
    expect(tecnico.length).toBe(4);
    expect(tecnico.map(s => s.nome).sort()).toEqual(["Banco de dados", "Carregamento", "Performance", "Segurança"].sort());
  });

  it("deve complementar os cards com o estado de instalação sem perder nenhuma das 10 skills", () => {
    // Simula estado de projeto onde 2 skills estão instaladas
    const mockInstalled = [
      { id: "frontend-design", installed: true },
      { id: "seo", installed: true }
    ];

    const statusMap = new Map(mockInstalled.map(s => [s.id, s]));
    const mappedSkills = OFFICIAL_SKILLS_CATALOG.map(def => {
      const live = statusMap.get(def.id);
      return {
        id: def.id,
        nome: def.nome,
        installed: live ? Boolean(live.installed) : false
      };
    });

    // Total de cards permanece exatamente 10
    expect(mappedSkills.length).toBe(10);

    // 2 instaladas, 8 disponíveis
    const installed = mappedSkills.filter(s => s.installed);
    const available = mappedSkills.filter(s => !s.installed);

    expect(installed.length).toBe(2);
    expect(available.length).toBe(8);
    expect(installed.map(s => s.id).sort()).toEqual(["frontend-design", "seo"].sort());
  });

  it("deve retornar estado consistente para getStatus sem projeto ativo (projectPath nulo)", async () => {
    const manager = new SkillsManager();
    const statusNoProject = await manager.getStatus(undefined);

    expect(statusNoProject.totalCount).toBe(10);
    expect(statusNoProject.installedCount).toBe(0);
    expect(statusNoProject.skills.length).toBe(10);
    expect(statusNoProject.skills.every(s => !s.installed)).toBe(true);
  });
});

