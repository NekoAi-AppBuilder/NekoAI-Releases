import test from "node:test";
import assert from "node:assert/strict";

function classifyProcessOutput(stream: "stdout" | "stderr", text: string, exitCode?: number): "log" | "error" {
  if (exitCode !== undefined && exitCode !== 0) {
    return "error";
  }
  if (stream === "stderr") {
    if (/fatal error|uncaught exception|panic:/i.test(text)) {
      return "error";
    }
    return "log";
  }
  return "log";
}

test("stderr and Process Exit Classification", async (t) => {
  await t.test("1. stderr with exitCode 0 is classified as LOG, not ERROR", () => {
    const kind = classifyProcessOutput("stderr", "(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.", 0);
    assert.strictEqual(kind, "log");
  });

  await t.test("2. stderr with exitCode 1 is classified as ERROR", () => {
    const kind = classifyProcessOutput("stderr", "Error: Cannot find module 'express'", 1);
    assert.strictEqual(kind, "error");
  });

  await t.test("3. stderr with fatal error without exitCode is classified as ERROR", () => {
    const kind = classifyProcessOutput("stderr", "fatal error: runtime: out of memory");
    assert.strictEqual(kind, "error");
  });

  await t.test("4. normal stdout with exitCode 0 is classified as LOG", () => {
    const kind = classifyProcessOutput("stdout", "Vite v5.4.2 ready in 250 ms", 0);
    assert.strictEqual(kind, "log");
  });
});
