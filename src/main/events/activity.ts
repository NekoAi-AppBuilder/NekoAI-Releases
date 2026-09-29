export function normalizeActivity(type: string, props: any) {
  const input = props?.input ?? props?.part?.state?.input ?? props?.part?.input ?? {};
  const path = props?.path ?? props?.filePath ?? props?.filepath ?? props?.file?.path ?? (typeof props?.file === "string" ? props.file : undefined) ?? input?.filePath ?? input?.filepath ?? input?.path ?? input?.file ?? input?.filename ?? "";
  const tool = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
  const command = input?.command ?? input?.cmd ?? props?.cmd ?? props?.command ?? "";
  const callId = props?.callID ?? props?.callId ?? props?.id ?? props?.part?.callID ?? props?.part?.callId ?? props?.part?.id ?? "";
  const sessionId = props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? "";
  const taskId = props?.taskId;
  const error = props?.error ?? props?.state?.error ?? props?.part?.state?.error;

  if ((type === "file.created" || type === "file.edited" || type === "file.deleted") && path) {
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

  const isMessagePartTool = type === "message.part.updated" && String(props?.part?.type ?? "") === "tool";
  if ((type.startsWith("tool.") || isMessagePartTool) && tool) {
    const isPart = isMessagePartTool;
    const partStatus = props?.part?.state?.status;
    const isPartError = partStatus === "error" || Boolean(error);
    const isPartDone = partStatus === "completed" || partStatus === "done" || partStatus === "success";

    const stage = isPart
      ? (isPartDone || isPartError ? "after" : partStatus === "running" ? "before" : "update")
      : (type.endsWith(".before") ? "before" : type.endsWith(".after") ? "after" : "update");

    const status = isPart
      ? (isPartError ? "error" : isPartDone ? "completed" : "running")
      : (stage === "before" ? "running" : (props?.state?.status === "error" || Boolean(error) ? "error" : "completed"));

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

