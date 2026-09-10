
const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".vite", ".cache",
  ".next", ".nuxt", "coverage", ".turbo", ".neko"
]);
const IGNORED_SUFFIXES = [".lock", ".tmp", ".log"];

export function shouldIgnoreEventPath(value: unknown) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized) return false;
  // Match whole path segments so real project files such as
  // src/components/Hero.css are never hidden by substring collisions
  // (for example a directory named "dist-module" or "blockade.js").
  const parts = normalized.split("/");
  if (parts.some(part => IGNORED_DIRS.has(part))) return true;
  if (IGNORED_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return true;
  return false;
}
