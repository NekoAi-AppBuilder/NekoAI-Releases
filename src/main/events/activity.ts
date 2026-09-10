
export function normalizeActivity(type: string, props: any) {
  const path = props?.path ?? props?.filePath ?? props?.file?.path ?? "";
  const tool = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
  const command = props?.input?.command ?? props?.cmd ?? "";
  if (type.startsWith("file.") && path)
    return { type:"neko.activity", properties:{ action:"file", path } };
  if (type.startsWith("tool.") && tool)
    return { type:"neko.activity", properties:{ action:"tool", tool, path, command } };
  if (type.startsWith("command.") && command)
    return { type:"neko.activity", properties:{ action:"command", command } };
  return null;
}
