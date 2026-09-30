import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function getDirSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else if (entry.isFile()) {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

const toolsDir = path.resolve(process.cwd(), "tools");
const subDirs = fs.readdirSync(toolsDir, { withFileTypes: true }).filter(d => d.isDirectory());

console.log("=== COMPONENT SIZES IN tools/ ===");
let totalBytes = 0;
for (const sub of subDirs) {
  const p = path.join(toolsDir, sub.name);
  const bytes = getDirSize(p);
  totalBytes += bytes;
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  console.log(`tools/${sub.name}: ${mb} MB (${bytes} bytes)`);
}

// opencode.exe single file
const opencodeExe = path.join(toolsDir, "opencode.exe");
if (fs.existsSync(opencodeExe)) {
  const bytes = fs.statSync(opencodeExe).size;
  totalBytes += bytes;
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  console.log(`tools/opencode.exe: ${mb} MB (${bytes} bytes)`);
}

console.log(`TOTAL tools/: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB (${totalBytes} bytes)`);

// Check parent versions for previous installer sizes
const parentDir = path.resolve(process.cwd(), "..");
console.log("\n=== PREVIOUS RELEASES IN SIBLING DIRECTORIES ===");
try {
  const siblings = fs.readdirSync(parentDir);
  for (const sib of siblings) {
    const relPath = path.join(parentDir, sib, "release");
    if (fs.existsSync(relPath)) {
      const files = fs.readdirSync(relPath);
      for (const f of files) {
        if (f.endsWith(".exe") && !f.endsWith(".blockmap")) {
          const full = path.join(relPath, f);
          const sz = fs.statSync(full).size;
          console.log(`${sib} / ${f}: ${(sz / (1024 * 1024)).toFixed(2)} MB (${sz} bytes)`);
        }
      }
    }
  }
} catch (e) {
  console.log("Could not check parent directory:", e.message);
}
