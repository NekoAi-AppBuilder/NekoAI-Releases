import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testsDir = join(process.cwd(), "tests");
const files = readdirSync(testsDir).filter(f => f.endsWith(".test.ts"));

console.log(`Found ${files.length} test files in tests/`);

let passedCount = 0;
let failedCount = 0;
const failedFiles = [];

for (const file of files) {
  const fullPath = join(testsDir, file);
  const result = spawnSync("bun", ["test", fullPath], {
    encoding: "utf8",
    env: process.env,
  });

  if (result.status === 0) {
    passedCount++;
    console.log(`✓ [PASS] ${file}`);
  } else {
    failedCount++;
    failedFiles.push({ file, output: result.stderr || result.stdout });
    console.log(`✗ [FAIL] ${file}`);
  }
}

console.log(`\n========================================`);
console.log(`TOTAL SUITES: ${files.length}`);
console.log(`PASSED: ${passedCount}`);
console.log(`FAILED: ${failedCount}`);
if (failedCount > 0) {
  console.log(`\nFailed Suites:`);
  for (const { file, output } of failedFiles) {
    console.log(`\n--- ${file} ---`);
    console.log(output.slice(0, 500));
  }
}
console.log(`========================================\n`);

process.exit(failedCount === 0 ? 0 : 1);
