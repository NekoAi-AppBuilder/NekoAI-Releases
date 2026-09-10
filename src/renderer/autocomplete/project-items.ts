import type { ProjectItem } from "./types.ts";

export function extractProjectItems(
  tree: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>
): {
  files: ProjectItem[];
  folders: ProjectItem[];
} {
  const files: ProjectItem[] = [];
  const folders: ProjectItem[] = [];

  function walk(nodes: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === "file") {
        files.push({ name: node.name, path: node.path, type: "file" });
      } else if (node.type === "directory") {
        folders.push({ name: node.name, path: node.path, type: "directory" });
        if (Array.isArray(node.children)) {
          walk(node.children);
        }
      }
    }
  }

  walk(tree);

  files.sort((a, b) => a.path.localeCompare(b.path));
  folders.sort((a, b) => a.path.localeCompare(b.path));

  return { files, folders };
}

export function filterProjectItems(items: ProjectItem[], query: string): ProjectItem[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return items;

  return items.filter(item =>
    item.path.toLowerCase().includes(clean) ||
    item.name.toLowerCase().includes(clean)
  );
}
