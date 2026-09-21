/**
 * Deterministic Session Hierarchy Management (Root <-> Child / Subagents).
 * Tracks childSessionId -> parentSessionId mappings emitted by OpenCode.
 */

export const sessionParentMap = new Map<string, string>();

export function registerSessionParent(childSessionId: string, parentSessionId: string): void {
  if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) return;
  sessionParentMap.set(childSessionId, parentSessionId);
}

export function resolveRootSessionId(
  sessionId: string,
  isKnownRoot: (sid: string) => boolean
): string {
  if (!sessionId) return "";
  let current = sessionId;
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    visited.add(current);
    if (isKnownRoot(current)) {
      return current;
    }
    const parent = sessionParentMap.get(current);
    if (!parent) break;
    current = parent;
  }
  return isKnownRoot(current) ? current : "";
}

export function clearSessionTree(): void {
  sessionParentMap.clear();
}
