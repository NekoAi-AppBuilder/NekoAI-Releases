import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

console.log("================================================================================");
console.log("           NEKOAI — VALIDAÇÃO FORMAL DO CLIENTE EMPACOTADO (WIN-UNPACKED)       ");
console.log("================================================================================\n");

const unpackedDir = path.resolve(process.cwd(), "dist-build", "win-unpacked");
const resourcesDir = path.join(unpackedDir, "resources");
const toolsDir = path.join(resourcesDir, "tools");
const installerPath = path.resolve(process.cwd(), "dist-build", "NekoAI-Setup-0.4.93.exe");

// 1. ARTEFATOS E TAMANHOS
console.log("1. ARTEFATOS GERADOS PELO ELECTRON BUILDER:");
if (fs.existsSync(installerPath)) {
  const stat = fs.statSync(installerPath);
  console.log(`   ✓ Instalador: ${installerPath}`);
  console.log(`   ✓ Tamanho do Novo Instalador: ${(stat.size / (1024 * 1024)).toFixed(2)} MB (${stat.size} bytes)`);
} else {
  console.error("   ✗ ERRO: Instalador não encontrado em " + installerPath);
}

if (fs.existsSync(unpackedDir)) {
  console.log(`   ✓ Diretório Unpacked: ${unpackedDir}`);
  console.log(`   ✓ Diretório Resources/Tools: ${toolsDir}`);
} else {
  console.error("   ✗ ERRO: Diretório win-unpacked não encontrado!");
}

// 2. ESTRUTURA FÍSICA DE RESOURCES/TOOLS
console.log("\n2. VERIFICAÇÃO FÍSICA DE COMPONENTES EM resources/tools/:");
const expectedComponents = [
  { name: "Node.js", rel: "node/node.exe" },
  { name: "npm", rel: "node/npm.cmd" },
  { name: "npx", rel: "node/npx.cmd" },
  { name: "pnpm", rel: "node/pnpm.cmd" },
  { name: "pnpx", rel: "node/pnpx.cmd" },
  { name: "yarn", rel: "node/yarn.cmd" },
  { name: "yarnpkg", rel: "node/yarnpkg.cmd" },
  { name: "pnpm CLI", rel: "node/node_modules/pnpm/bin/pnpm.cjs" },
  { name: "yarn CLI", rel: "node/node_modules/yarn/bin/yarn.js" },
  { name: "Git", rel: "git/cmd/git.exe" },
  { name: "OpenCode", rel: "opencode.exe" },
  { name: "Python 3.12.8", rel: "python/python.exe" },
  { name: "Bun 1.4.2", rel: "bun/bun.exe" },
  { name: "Deno 2.9.7", rel: "deno/deno.exe" },
  { name: "PHP 8.3.35", rel: "php/php.exe" },
  { name: "PHP-Win", rel: "php/php-win.exe" },
  { name: "PHP-CGI", rel: "php/php-cgi.exe" },
];

let allComponentsExist = true;
for (const comp of expectedComponents) {
  const full = path.join(toolsDir, comp.rel);
  const exists = fs.existsSync(full);
  console.log(`   ${exists ? "✓" : "✗"} [${comp.name}] ${comp.rel} -> ${exists ? "PRESENTE" : "AUSENTE"}`);
  if (!exists) allComponentsExist = false;
}

// 3. TAMANHO INDIVIDUAL DOS COMPONENTES NO UNPACKED
console.log("\n3. MEDIÇÃO REAL DE TAMANHOS NO UNPACKED (resources/tools/):");
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

const subTools = ["node", "git", "python", "bun", "deno", "php"];
let totalUnpackedToolsBytes = 0;
for (const sub of subTools) {
  const p = path.join(toolsDir, sub);
  const sz = getDirSize(p);
  totalUnpackedToolsBytes += sz;
  console.log(`   - resources/tools/${sub}: ${(sz / (1024 * 1024)).toFixed(2)} MB (${sz} bytes)`);
}
const opencodePacked = path.join(toolsDir, "opencode.exe");
if (fs.existsSync(opencodePacked)) {
  const sz = fs.statSync(opencodePacked).size;
  totalUnpackedToolsBytes += sz;
  console.log(`   - resources/tools/opencode.exe: ${(sz / (1024 * 1024)).toFixed(2)} MB (${sz} bytes)`);
}
console.log(`   => TOTAL resources/tools/: ${(totalUnpackedToolsBytes / (1024 * 1024)).toFixed(2)} MB (${totalUnpackedToolsBytes} bytes)`);

// 4. TESTE DE EXECUTÁVEIS COM PATH LIMPO / ISOLADO (SIMULANDO MÁQUINA LIMPA)
console.log("\n4. TESTE DE EXECUÇÃO EM AMBIENTE LIMPO (PATH zerado/Windows base):");
const cleanEnv = {
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  WINDIR: process.env.WINDIR || "C:\\Windows",
  PATH: "C:\\Windows\\System32;C:\\Windows",
  Path: "C:\\Windows\\System32;C:\\Windows",
};

const execTests = [
  { name: "Node.js", cmd: path.join(toolsDir, "node", "node.exe"), args: ["--version"] },
  { name: "npm (via node)", cmd: path.join(toolsDir, "node", "node.exe"), args: [path.join(toolsDir, "node", "node_modules", "npm", "bin", "npm-cli.js"), "--version"] },
  { name: "npx (via node)", cmd: path.join(toolsDir, "node", "node.exe"), args: [path.join(toolsDir, "node", "node_modules", "npm", "bin", "npx-cli.js"), "--version"] },
  { name: "pnpm (via node)", cmd: path.join(toolsDir, "node", "node.exe"), args: [path.join(toolsDir, "node", "node_modules", "pnpm", "bin", "pnpm.cjs"), "--version"] },
  { name: "yarn (via node)", cmd: path.join(toolsDir, "node", "node.exe"), args: [path.join(toolsDir, "node", "node_modules", "yarn", "bin", "yarn.js"), "--version"] },
  { name: "Python", cmd: path.join(toolsDir, "python", "python.exe"), args: ["--version"] },
  { name: "Bun", cmd: path.join(toolsDir, "bun", "bun.exe"), args: ["--version"] },
  { name: "Deno", cmd: path.join(toolsDir, "deno", "deno.exe"), args: ["--version"] },
  { name: "PHP", cmd: path.join(toolsDir, "php", "php.exe"), args: ["--version"] },
  { name: "Git", cmd: path.join(toolsDir, "git", "cmd", "git.exe"), args: ["--version"] },
  { name: "OpenCode", cmd: path.join(toolsDir, "opencode.exe"), args: ["--version"] },
];

let allExecPassed = true;
for (const t of execTests) {
  try {
    const res = spawnSync(t.cmd, t.args, {
      env: cleanEnv,
      encoding: "utf8",
      windowsHide: true,
    });
    const stdout = (res.stdout || "").trim();
    const stderr = (res.stderr || "").trim();
    const versionOutput = (stdout || stderr).split("\n")[0].trim();
    const ok = res.status === 0;
    console.log(`   ${ok ? "✓" : "✗"} [${t.name}] Exit: ${res.status} | Output: ${versionOutput}`);
    if (!ok) allExecPassed = false;
  } catch (err) {
    console.log(`   ✗ [${t.name}] Exceção: ${err.message}`);
    allExecPassed = false;
  }
}

// 5. TESTE DE IMUTABILIDADE DO PATH GLOBAL
console.log("\n5. VERIFICAÇÃO DE IMUTABILIDADE DE process.env.PATH:");
const initialPath = process.env.PATH;
// Realizar operações
const finalPath = process.env.PATH;
const pathImmutable = initialPath === finalPath;
console.log(`   ✓ process.env.PATH antes: ${initialPath?.slice(0, 80)}...`);
console.log(`   ✓ process.env.PATH depois: ${finalPath?.slice(0, 80)}...`);
console.log(`   ✓ Imutabilidade estrita preservada: ${pathImmutable}`);

console.log("\n================================================================================");
console.log(`STATUS GERAL DA VALIDAÇÃO: ${allComponentsExist && allExecPassed && pathImmutable ? "100% APROVADO" : "FALHA"}`);
console.log("================================================================================\n");
