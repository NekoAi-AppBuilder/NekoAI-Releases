
export function normalizeActivity(type: string, props: any) {
  const path = props?.path ?? props?.filePath ?? props?.file?.path ?? (typeof props?.file === "string" ? props.file : "") ?? props?.input?.filePath ?? props?.input?.path ?? props?.input?.filename ?? "";
  const tool = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
  const command = props?.input?.command ?? props?.cmd ?? props?.command ?? props?.part?.state?.input?.command ?? "";
  const callId = props?.callID ?? props?.callId ?? props?.id ?? props?.part?.id ?? props?.part?.callID ?? props?.part?.callId ?? "";
  const sessionId = props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? "";
  const taskId = props?.taskId;
  const error = props?.error ?? props?.state?.error ?? props?.part?.state?.error;

  if (type.startsWith("file.") && path) {
    const actionType = type === "file.created" ? "created" : type === "file.deleted" ? "deleted" : "edited";
    return {
      type: "neko.activity",
      properties: {
        action: "file",
        actionType,
        path,
        status: "completed",
        callId: callId || undefined,
        sessionId: sessionId || undefined,
        taskId: taskId || undefined
      }
    };
  }

  if (type.startsWith("tool.") && tool) {
    const stage = type.endsWith(".before") ? "before" : type.endsWith(".after") ? "after" : "update";
    const status = stage === "before" ? "running" : (props?.state?.status === "error" || Boolean(error) ? "error" : "completed");
    return {
      type: "neko.activity",
      properties: {
        action: "tool",
        tool,
        path,
        command,
        stage,
        status,
        callId: callId || undefined,
        sessionId: sessionId || undefined,
        taskId: taskId || undefined,
        error: error ? String(error?.message ?? error) : undefined
      }
    };
  }

  if (type.startsWith("command.") && command) {
    return {
      type: "neko.activity",
      properties: {
        action: "command",
        command,
        status: "completed",
        callId: callId || undefined,
        sessionId: sessionId || undefined,
        taskId: taskId || undefined
      }
    };
  }

  return null;
}

