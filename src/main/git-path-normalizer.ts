import path from "node:path";

/**
 * Normaliza caminhos de arquivos relativos à raiz do repositório Git para uso
 * seguro em operações de commit seletivo (ex: git add -- <path>).
 *
 * Regras estritas:
 * 1. Converte separadores Windows (\) para (/);
 * 2. Remove prefixo "./" ou "/" redundante se realmente existir;
 * 3. Se receber caminho absoluto comprovadamente dentro do repositório, converte para relativo via path.relative;
 * 4. NUNCA remove o primeiro caractere de caminhos relativos normais (ex: "index.html" -> "index.html");
 * 5. Rejeita paths vazios ou tentativas de Directory Traversal ("../") que escapem da raiz do repositório;
 * 6. Preserva exatamente o nome do arquivo, espaços internos, hífens, acentos e underscores.
 */
export function normalizeRepoRelativePath(rawPath: string, repoRoot?: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("Caminho de arquivo inválido para o commit.");
  }

  let p = rawPath.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).trim();
  }

  if (!p) {
    throw new Error("Caminho de arquivo vazio para o commit.");
  }

  // Se o caminho for absoluto e repoRoot for fornecido, resolve relativo à raiz
  if (repoRoot && (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p))) {
    const canonicalRoot = path.resolve(repoRoot);
    const canonicalTarget = path.resolve(p);
    const rel = path.relative(canonicalRoot, canonicalTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Caminho fora do repositório não permitido: ${p}`);
    }
    p = rel;
  }

  // Normaliza barras para o padrão POSIX
  p = p.replaceAll("\\", "/");

  // Remove apenas prefixos explícitos "./" ou "/"
  p = p.replace(/^(\.\/)+/, "");
  p = p.replace(/^\/+/, "");

  // Rejeita caminhos que tentem escapar da raiz (Directory Traversal)
  const posixNormalized = path.posix.normalize(p);
  if (posixNormalized === ".." || posixNormalized.startsWith("../") || path.isAbsolute(posixNormalized)) {
    throw new Error(`Tentativa de escapar da raiz do repositório detectada: ${p}`);
  }

  return p;
}

export interface GitPathDiagnostic {
  path: string;
  existsInWorkingTree: boolean;
  statusMatch: boolean;
  branchesContainingFile?: string[];
  reason?: "deleted" | "other_branch" | "stale_not_found";
  message?: string;
}

/**
 * Diagnostica se um arquivo selecionado para commit existe no working tree atual
 * e, caso não exista, verifica em quais outras branches locais/remotas o arquivo existe.
 */
export async function diagnoseGitFilePath(
  relativePath: string,
  repoRoot: string,
  currentStatusFiles: string[],
  currentBranch: string | null,
  gitRunner: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
): Promise<GitPathDiagnostic> {
  const norm = normalizeRepoRelativePath(relativePath, repoRoot);
  const fullPath = path.resolve(repoRoot, norm);
  const fs = await import("node:fs");
  const exists = fs.existsSync(fullPath);
  const inStatus = currentStatusFiles.includes(norm);

  if (exists && inStatus) {
    return { path: norm, existsInWorkingTree: true, statusMatch: true };
  }

  if (inStatus && !exists) {
    // Arquivo está no status (ex: deleted no working tree)
    return {
      path: norm,
      existsInWorkingTree: false,
      statusMatch: true,
      reason: "deleted"
    };
  }

  // Arquivo não existe no working tree e nem no status atual:
  // Procurar se existe em outra branch (local ou remota)
  const branches: string[] = [];
  try {
    const refsRes = await gitRunner(["for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/remotes/"]);
    if (refsRes.code === 0) {
      const allRefs = refsRes.stdout.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
      for (const ref of allRefs) {
        if (ref === "origin" || ref === "HEAD" || ref === "origin/HEAD") continue;
        const cleanRef = ref.startsWith("origin/") ? ref.slice(7) : ref;
        if (currentBranch && (ref === currentBranch || cleanRef === currentBranch)) continue;
        const lsRes = await gitRunner(["ls-tree", "--name-only", ref, "--", norm]);
        if (lsRes.code === 0 && lsRes.stdout.trim().length > 0) {
          branches.push(cleanRef);
        }
      }
    }
  } catch (err) {
    console.warn(`[GitDiagnostic] erro ao pesquisar arquivo em outras branches:`, err);
  }

  if (branches.length > 0) {
    const branchList = Array.from(new Set(branches)).join(", ");
    return {
      path: norm,
      existsInWorkingTree: false,
      statusMatch: false,
      branchesContainingFile: Array.from(new Set(branches)),
      reason: "other_branch",
      message: `Este arquivo não existe na branch ${currentBranch || "atual"}. Ele existe na(s) branch(es): ${branchList}.`
    };
  }

  return {
    path: norm,
    existsInWorkingTree: false,
    statusMatch: false,
    reason: "stale_not_found",
    message: `Este arquivo não existe na branch ${currentBranch || "atual"} e não foi encontrado no working tree.`
  };
}

