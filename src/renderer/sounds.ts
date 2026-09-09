// ============================================================
// NOTIFICATION SOUNDS (renderer)
// ------------------------------------------------------------
// Avisos sonoros discretos e OFFLINE para eventos reais do NekoAI,
// sintetizados com Web Audio (nenhum arquivo/URL externa). Respeita a
// configuração ON/OFF persistida em localStorage. Deduplica por id, então o
// mesmo evento (task/question/permission/plan) toca no máximo uma vez.
// Falhas de áudio/autoplay nunca quebram a aplicação.
// ============================================================

export type NotifyKind = "task-complete" | "task-error" | "question" | "approval" | "plan" | "test";

const STORAGE_KEY = "nekoai.soundEnabled";
const DEDUPE_WINDOW_MS = 60_000;

function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = readStoredEnabled();
let ctx: AudioContext | null = null;
const played = new Map<string, number>();

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): boolean {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {}
  return enabled;
}

function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, startDelay: number, duration: number, type: OscillatorType = "sine", peak = 0.28): void {
  const c = ctx;
  if (!c) return;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = c.currentTime + startDelay;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch {} };
  } catch {}
}

export function playNotify(kind: NotifyKind): void {
  if (!enabled) return;
  const c = audioContext();
  if (!c) return;
  try {
    switch (kind) {
      case "task-complete":
        tone(660, 0, 0.18, "sine", 0.32);
        tone(990, 0.12, 0.24, "sine", 0.32);
        break;
      case "task-error":
        tone(330, 0, 0.2, "triangle", 0.28);
        tone(220, 0.14, 0.28, "triangle", 0.28);
        break;
      case "question":
        tone(523, 0, 0.16, "sine", 0.30);
        tone(784, 0.12, 0.2, "sine", 0.30);
        break;
      case "approval":
        tone(587, 0, 0.14, "sine", 0.30);
        tone(880, 0.1, 0.18, "sine", 0.28);
        break;
      case "plan":
        tone(494, 0, 0.16, "sine", 0.28);
        tone(659, 0.11, 0.2, "sine", 0.28);
        break;
      case "test":
        tone(700, 0, 0.22, "sine", 0.30);
        break;
    }
  } catch {}
}

// Toca no máximo uma vez por (kind + id) dentro da janela de deduplicação.
export function notifyOnce(kind: NotifyKind, id: string): void {
  if (!enabled) return;
  const key = `${kind}:${id || "default"}`;
  const now = Date.now();
  const last = played.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return;
  played.set(key, now);
  // limita memória
  if (played.size > 500) {
    const oldest = Array.from(played.entries()).sort((a, b) => a[1] - b[1])[0];
    if (oldest) played.delete(oldest[0]);
  }
  playNotify(kind);
}

export function resetPlayedSounds(): void {
  played.clear();
}

// Desbloqueia o AudioContext no primeiro gesto do usuário (autoplay policy).
export function unlockAudio(): void {
  try {
    const c = audioContext();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
  } catch {}
}
