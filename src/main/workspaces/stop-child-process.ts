import { spawn, type ChildProcess } from "node:child_process";

/** Terminates exactly the captured process tree, without reading an active-workspace global. */
export async function stopChildProcessTree(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExit: () => void = () => {};
  const exited = new Promise<void>((resolve, reject) => {
    onExit = resolve;
    child.once("exit", onExit);
    timer = setTimeout(() => reject(new Error("O processo do projeto não encerrou no prazo esperado.")), timeoutMs);
  });
  // Attach rejection handling immediately while taskkill is still executing.
  const observedExit = exited.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", reject);
        killer.once("exit", code => {
          if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(new Error(`Não foi possível encerrar a árvore do processo (código ${code}).`));
        });
      });
    } else if (!child.kill("SIGTERM")) {
      throw new Error("Não foi possível sinalizar o encerramento do processo.");
    }
    const result = await observedExit;
    if (!result.ok) throw result.error;
  } finally {
    clearTimeout(timer);
    child.removeListener("exit", onExit);
  }
}
