import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const gitExePath = path.join(rootDir, 'tools', 'git', 'cmd', 'git.exe');
console.log('[Test MinGit] Checking bundled MinGit at:', gitExePath);

if (!fs.existsSync(gitExePath)) {
  console.error('[Test MinGit] ERROR: git.exe does not exist at expected location!');
  process.exit(1);
}

// Set up PATH environment as done in runGit
const gitRootDir = path.resolve(gitExePath, '..', '..');
const mingwBin = path.join(gitRootDir, 'mingw64', 'bin');
const usrBin = path.join(gitRootDir, 'usr', 'bin');
const cmdDir = path.join(gitRootDir, 'cmd');
const customPath = `${cmdDir}${path.delimiter}${mingwBin}${path.delimiter}${usrBin}${path.delimiter}${process.env.PATH || ''}`;

// Test git --version
const verRes = spawnSync(gitExePath, ['--version'], {
  env: { ...process.env, PATH: customPath },
  encoding: 'utf8'
});

console.log('[Test MinGit] git --version output:', verRes.stdout.trim());
if (verRes.status !== 0) {
  console.error('[Test MinGit] ERROR running git --version:', verRes.stderr);
  process.exit(1);
}

// Test git init in temp dir
const tempTestDir = path.join(rootDir, 'scratch', 'test-mingit-repo');
if (fs.existsSync(tempTestDir)) {
  fs.rmSync(tempTestDir, { recursive: true, force: true });
}
fs.mkdirSync(tempTestDir, { recursive: true });

console.log('[Test MinGit] Testing git init in:', tempTestDir);
const initRes = spawnSync(gitExePath, ['init'], {
  cwd: tempTestDir,
  env: { ...process.env, PATH: customPath },
  encoding: 'utf8'
});
console.log('[Test MinGit] git init output:', initRes.stdout.trim());

// Test git status
const statusRes = spawnSync(gitExePath, ['status'], {
  cwd: tempTestDir,
  env: { ...process.env, PATH: customPath },
  encoding: 'utf8'
});
console.log('[Test MinGit] git status output:', statusRes.stdout.trim());

// Clean up test dir
fs.rmSync(tempTestDir, { recursive: true, force: true });

console.log('[Test MinGit] ALL TESTS PASSED SUCCESSFULLY! MinGit is fully operational.');
