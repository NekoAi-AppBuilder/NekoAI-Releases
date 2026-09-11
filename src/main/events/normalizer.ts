
import { shouldIgnoreEventPath } from "./filters";
import { normalizeActivity } from "./activity";

const statusCache = new Map<string, string>();

export function clearStatusCache() {
  statusCache.clear();
}

export function clearStatusCacheForSession(sessionId: string) {
  if (sessionId) {
    statusCache.delete(sessionId);
    statusCache.delete("default");
  }
}

export function normalizeOpenCodeEvent(event: any) {
  const type = String(event?.type ?? "");
  const props = event?.properties ?? {};
  if (type === "session.updated" || type === "session.diff") return null;

  if (type === "session.status") {
    const id = String(props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? event?.sessionID ?? event?.sessionId ?? "default");
    const status = String(props?.status?.type ?? props?.status ?? "");
    const taskId = props?.taskId;
    if (statusCache.get(id) === status) return null;
    statusCache.set(id, status);
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

  const path = props?.path ?? props?.filePath ?? (typeof props?.file === "string" ? props.file : props?.file?.path);
  if (path && shouldIgnoreEventPath(path)) return null;

  return normalizeActivity(type, props) ?? event;
}
