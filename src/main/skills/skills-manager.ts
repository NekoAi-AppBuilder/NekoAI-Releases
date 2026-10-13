import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  SKILLS_CATALOG,
  getSkillById,
  PASTA_DAS_SKILLS,
  type SkillDefinition,
  type SkillStatusInfo,
  type SkillsProjectState
} from "./skills-catalog.js";

export class SkillsManager {
  private currentProject: string | null = null;
  private assetsDir: string;

  constructor() {
    this.assetsDir = this.resolveAssetsDir();
  }

  /**
   * Resolve o diretório onde os assets das skills estão empacotados.
   * Funciona tanto em desenvolvimento (src/ ou dist/) quanto empacotado no Electron.
   */
  public resolveAssetsDir(): string {
    const candidatePaths = [
      path.join(__dirname, "assets"),
      path.join(__dirname, "skills", "assets"),
      path.join(process.cwd(), "dist", "main", "skills", "assets"),
      path.join(process.cwd(), "src", "main", "skills", "assets"),
    ];

    if (app && typeof app.getAppPath === "function") {
      try {
        const appPath = app.getAppPath();
        candidatePaths.unshift(
          path.join(appPath, "dist", "main", "skills", "assets"),
          path.join(appPath, "src", "main", "skills", "assets")
        );
      } catch {}
    }

    for (const candidate of candidatePaths) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback padrão relativo
    return path.join(__dirname, "assets");
  }

  public getAssetsDir(): string {
    return this.assetsDir;
  }

  public setProject(projectPath: string | null): void {
    this.currentProject = projectPath ? path.resolve(projectPath) : null;
  }

  public getCurrentProject(): string | null {
    return this.currentProject;
  }

  /**
   * Valida a integridade do catálogo e dos assets empacotados.
   * Retorna os detalhes de validação (útil para testes de build e integridade).
   */
  public validateCatalogIntegrity(): {
    valid: boolean;
    skillsCount: number;
    totalFilesExpected: number;
    totalFilesFound: number;
    errors: string[];
  } {
    const errors: string[] = [];
    let totalFilesExpected = 0;
    let totalFilesFound = 0;

    if (!fsSync.existsSync(this.assetsDir)) {
      return {
        valid: false,
        skillsCount: SKILLS_CATALOG.length,
        totalFilesExpected: 92,
        totalFilesFound: 0,
        errors: [`Diretório de assets das skills não encontrado em ${this.assetsDir}`]
      };
    }

    for (const skill of SKILLS_CATALOG) {
      const skillDir = path.join(this.assetsDir, skill.id);
      if (!fsSync.existsSync(skillDir)) {
        errors.push(`Diretório da skill ${skill.id} ausente em ${skillDir}`);
        continue;
      }

      for (const relFile of skill.arquivos) {
        totalFilesExpected++;
        const filePath = path.join(skillDir, relFile);
        if (fsSync.existsSync(filePath)) {
          totalFilesFound++;
        } else {
          errors.push(`Arquivo obrigatório ausente: ${skill.id}/${relFile}`);
        }
      }
    }

    return {
      valid: errors.length === 0 && totalFilesExpected === 92 && totalFilesFound === 92,
      skillsCount: SKILLS_CATALOG.length,
      totalFilesExpected,
      totalFilesFound,
      errors
    };
  }

  /**
   * Obtém o status de todas as skills para o projeto ativo.
   */
  public async getStatus(targetProjectPath?: string): Promise<SkillsProjectState> {
    const projectRoot = targetProjectPath ? path.resolve(targetProjectPath) : this.currentProject;

    if (!projectRoot || !fsSync.existsSync(projectRoot)) {
      return {
        projectPath: projectRoot,
        installedCount: 0,
        totalCount: SKILLS_CATALOG.length,
        skills: SKILLS_CATALOG.map(s => ({
          id: s.id,
          nome: s.nome,
          grupo: s.grupo,
          resumo: s.resumo,
          quando: s.quando,
          nota: s.nota,
          arquivosCount: s.arquivos.length,
          relativePath: `${PASTA_DAS_SKILLS}${s.id}/`,
          installed: false,
          usar: s.usar
        }))
      };
    }

    const skillsStatus: SkillStatusInfo[] = [];
    let installedCount = 0;

    for (const skill of SKILLS_CATALOG) {
      const destDir = path.join(projectRoot, ".agents", "skills", skill.id);
      const isInstalled = await this.isSkillInstalled(destDir, skill);

      if (isInstalled.installed) {
        installedCount++;
      }

      skillsStatus.push({
        id: skill.id,
        nome: skill.nome,
        grupo: skill.grupo,
        resumo: skill.resumo,
        quando: skill.quando,
        nota: skill.nota,
        arquivosCount: skill.arquivos.length,
        relativePath: `${PASTA_DAS_SKILLS}${skill.id}/`,
        installed: isInstalled.installed,
        incomplete: isInstalled.incomplete || false,
        missingFiles: isInstalled.missingFiles,
        usar: skill.usar
      });
    }

    return {
      projectPath: projectRoot,
      installedCount,
      totalCount: SKILLS_CATALOG.length,
      skills: skillsStatus
    };
  }

  /**
   * Verifica se uma skill está instalada no diretório especificado.
   * Não considera instalada se apenas a pasta existir vazia; valida SKILL.md e arquivos essenciais.
   */
  private async isSkillInstalled(
    skillDir: string,
    skill: SkillDefinition
  ): Promise<{ installed: boolean; incomplete?: boolean; missingFiles?: string[] }> {
    if (!fsSync.existsSync(skillDir)) {
      return { installed: false };
    }

    const mainFile = path.join(skillDir, "SKILL.md");
    if (!fsSync.existsSync(mainFile)) {
      return { installed: false, incomplete: true, missingFiles: ["SKILL.md"] };
    }

    const missingFiles: string[] = [];
    for (const relFile of skill.arquivos) {
      const fullPath = path.join(skillDir, relFile);
      if (!fsSync.existsSync(fullPath)) {
        missingFiles.push(relFile);
      }
    }

    if (missingFiles.length > 0) {
      // Incompleta: tem SKILL.md mas faltam arquivos do playbook
      return { installed: false, incomplete: true, missingFiles };
    }

    return { installed: true };
  }

  /**
   * Instala uma skill no projeto ativo.
   */
  public async installSkill(
    skillId: string,
    targetProjectPath?: string
  ): Promise<{ success: boolean; skillId: string; installedPath: string; filesCopied: number; error?: string }> {
    const projectRoot = targetProjectPath ? path.resolve(targetProjectPath) : this.currentProject;
    if (!projectRoot) {
      throw new Error("Nenhum projeto ativo para instalar a skill.");
    }

    const skill = getSkillById(skillId);
    if (!skill) {
      throw new Error(`Skill não encontrada no catálogo: ${skillId}`);
    }

    // Prevenção contra Directory Traversal
    const safeId = path.basename(skillId);
    if (safeId !== skillId) {
      throw new Error("Identificador de skill inválido.");
    }

    const sourceSkillDir = path.join(this.assetsDir, safeId);
    if (!fsSync.existsSync(sourceSkillDir)) {
      throw new Error(`Arquivos de origem da skill ${skillId} não encontrados em ${sourceSkillDir}`);
    }

    const targetBase = path.resolve(projectRoot, ".agents", "skills");
    const targetSkillDir = path.resolve(targetBase, safeId);

    // Validação estrita: destino deve estar contido em .agents/skills
    if (!targetSkillDir.startsWith(targetBase)) {
      throw new Error("Caminho de destino não autorizado.");
    }

    await fs.mkdir(targetSkillDir, { recursive: true });

    let filesCopied = 0;
    for (const relFile of skill.arquivos) {
      const srcFile = path.join(sourceSkillDir, relFile);
      const dstFile = path.join(targetSkillDir, relFile);

      if (!fsSync.existsSync(srcFile)) {
        throw new Error(`Arquivo de origem ausente: ${relFile}`);
      }

      await fs.mkdir(path.dirname(dstFile), { recursive: true });
      await fs.copyFile(srcFile, dstFile);
      filesCopied++;
    }

    return {
      success: true,
      skillId,
      installedPath: path.relative(projectRoot, targetSkillDir).replace(/\\/g, "/"),
      filesCopied
    };
  }

  /**
   * Remove uma skill do projeto ativo.
   */
  public async removeSkill(
    skillId: string,
    targetProjectPath?: string
  ): Promise<{ success: boolean; skillId: string; removed: boolean; error?: string }> {
    const projectRoot = targetProjectPath ? path.resolve(targetProjectPath) : this.currentProject;
    if (!projectRoot) {
      throw new Error("Nenhum projeto ativo para remover a skill.");
    }

    const skill = getSkillById(skillId);
    if (!skill) {
      throw new Error(`Skill não encontrada no catálogo: ${skillId}`);
    }

    const safeId = path.basename(skillId);
    if (safeId !== skillId) {
      throw new Error("Identificador de skill inválido.");
    }

    const targetBase = path.resolve(projectRoot, ".agents", "skills");
    const targetSkillDir = path.resolve(targetBase, safeId);

    if (!targetSkillDir.startsWith(targetBase)) {
      throw new Error("Caminho de exclusão não autorizado.");
    }

    if (!fsSync.existsSync(targetSkillDir)) {
      return { success: true, skillId, removed: false };
    }

    await fs.rm(targetSkillDir, { recursive: true, force: true });

    // Se .agents/skills ficou vazia, podemos mantê-la ou deixá-la quieta
    return { success: true, skillId, removed: true };
  }

  /**
   * Prepara o prompt oficial para execução da skill.
   */
  public getExecutionPrompt(skillId: string): { prompt: string; rotulo: string; pedido: string } {
    const skill = getSkillById(skillId);
    if (!skill) {
      throw new Error(`Skill não encontrada: ${skillId}`);
    }
    return {
      prompt: skill.usar.prompt,
      rotulo: skill.usar.rotulo,
      pedido: skill.usar.pedido
    };
  }
}

export const skillsManager = new SkillsManager();
