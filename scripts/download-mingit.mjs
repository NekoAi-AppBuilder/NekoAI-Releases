import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const toolsDir = path.join(rootDir, 'tools');
const gitDir = path.join(toolsDir, 'git');
const zipPath = path.join(toolsDir, 'mingit.zip');

console.log('[MinGit] Preparing MinGit directory...');
if (!fs.existsSync(toolsDir)) {
  fs.mkdirSync(toolsDir, { recursive: true });
}

// Download MinGit zip using PowerShell
const mingitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/MinGit-2.48.1-64-bit.zip';

console.log(`[MinGit] Downloading from ${mingitUrl}...`);
const psDownloadCmd = `powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('${mingitUrl}', '${zipPath.replace(/\\/g, '/')}')"`;
execSync(psDownloadCmd, { stdio: 'inherit' });

console.log('[MinGit] Extracting archive to tools/git...');
if (fs.existsSync(gitDir)) {
  fs.rmSync(gitDir, { recursive: true, force: true });
}
fs.mkdirSync(gitDir, { recursive: true });

const psExpandCmd = `powershell -Command "Expand-Archive -Path '${zipPath.replace(/\\/g, '/')}' -DestinationPath '${gitDir.replace(/\\/g, '/')}' -Force"`;
execSync(psExpandCmd, { stdio: 'inherit' });

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

const gitExeCmd = path.join(gitDir, 'cmd', 'git.exe');
const gitExeBin = path.join(gitDir, 'mingw64', 'bin', 'git.exe');

if (fs.existsSync(gitExeCmd) || fs.existsSync(gitExeBin)) {
  console.log('[MinGit] MinGit downloaded and extracted successfully!');
  console.log('[MinGit] git.exe path:', fs.existsSync(gitExeCmd) ? gitExeCmd : gitExeBin);
} else {
  console.error('[MinGit] Error: git.exe not found after extraction!');
  process.exit(1);
}
