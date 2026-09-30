import { test } from "bun:test";

if (typeof (globalThis as any).Deno === "undefined") {
  (globalThis as any).Deno = {
    env: {
      get: (k: string) => process.env[k] || "",
    },
    test: (nameOrFn: any, maybeFn?: any) => {
      const name = typeof nameOrFn === "string" ? nameOrFn : (nameOrFn?.name || "deno test");
      const fn = typeof nameOrFn === "function" ? nameOrFn : maybeFn;
      if (typeof fn === "function") {
        test(name, fn);
      }
    },
  };
}
