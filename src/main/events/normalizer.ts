
import { shouldIgnoreEventPath } from "./filters";
import { normalizeActivity } from "./activity";

const statusCache = new Map<string, string>();

export function clearStatusCache(cache: Map<string, string> = statusCache) {
  cache.clear();
}

export function clearStatusCacheForSession(sessionId: string, cache: Map<string, string> = statusCache) {
  if (sessionId) {
    cache.delete(sessionId);
    cache.delete("default");
  }
}

export function normalizeOpenCodeEvent(event: any, cache: Map<string, string> = statusCache) {
  const type = String(event?.type ?? "");
  const props = event?.properties ?? {};
  if (type === "session.updated" || type === "session.diff") return null;

  if (type === "session.status") {
    const id = String(props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? event?.sessionID ?? event?.sessionId ?? "default");
    const status = String(props?.status?.type ?? props?.status ?? "");
    const taskId = props?.taskId;
    if (cache.get(id) === status) return null;
    cache.set(id, status);
    return {
      type: "neko.status",
      properties: {
        sessionID: id,
        taskId: taskId || undefined,
        state: status === "busy" ? "working" :
               status === "idle" ? "idle" : status
      }
    };
  }

  const input = props?.input ?? props?.part?.state?.input ?? props?.part?.input ?? {};
  const path = props?.path ?? props?.filePath ?? props?.filepath ?? (typeof props?.file === "string" ? props.file : props?.file?.path) ?? input?.filePath ?? input?.filepath ?? input?.path ?? input?.file ?? input?.filename;
  if (path && shouldIgnoreEventPath(path)) return null;

  const sessionID = props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? event?.sessionID ?? event?.sessionId;
  const taskId = props?.taskId ?? event?.taskId;
  return normalizeActivity(type, { ...props, sessionID, taskId }) ?? event;
}
