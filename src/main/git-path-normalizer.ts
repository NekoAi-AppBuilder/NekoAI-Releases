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
