export type PromptQueueGateState = { revision: number; paused: boolean; reason: string; project: string };

/** One admission gate for all studios. A stale resume cannot clear a newer error. */
export class PromptQueueGate {
  private state: PromptQueueGateState = { revision: 0, paused: false, reason: "", project: "" };
  snapshot(): PromptQueueGateState { return { ...this.state }; }
  permits(revision: number): boolean { return !this.state.paused && revision === this.state.revision; }
  pause(reason: string, project = ""): PromptQueueGateState {
    if (!this.state.paused || this.state.reason !== reason || this.state.project !== project) {
      this.state = { revision: this.state.revision + 1, paused: true, reason, project };
    }
    return this.snapshot();
  }
  resume(revision: number): PromptQueueGateState {
    if (revision === this.state.revision) this.state = { revision: revision + 1, paused: false, reason: "", project: "" };
    return this.snapshot();
  }
}

export type PromptQueueIdentity = { id: string; sessionId: string; projectPath: string };
export type PromptQueueSnapshot<T> = { pending: readonly T[]; active: T | null; pauseReason: string };

/** A studio owns this queue for its entire lifetime, including while hidden. */
export class PromptQueue<T extends PromptQueueIdentity> {
  private pending: T[] = [];
  private active: T | null = null;
  private pauseReason = "";
  private listeners = new Set<() => void>();
  snapshot(): PromptQueueSnapshot<T> { return { pending: [...this.pending], active: this.active, pauseReason: this.pauseReason }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  enqueue(item: T): void { this.pending.push(item); this.changed(); }
  take(sessionId: string, projectPath: string): T | null {
    if (this.active || this.pauseReason || !this.pending.length) return null;
    const item = this.pending[0];
    if (item.sessionId !== sessionId || item.projectPath !== projectPath) {
      this.pause("A sessão do projeto mudou. Revise ou remova os prompts pendentes.");
      return null;
    }
    this.active = this.pending.shift()!;
    this.changed();
    return this.active;
  }
  finish(id: string): boolean {
    if (this.active?.id !== id) return false;
    this.active = null; this.changed(); return true;
  }
  defer(id: string): void {
    if (this.active?.id !== id) return;
    this.pending.unshift(this.active); this.active = null; this.changed();
  }
  pause(reason: string): void { this.pauseReason = reason; this.changed(); }
  resume(): void { this.pauseReason = ""; this.changed(); }
  remove(id: string): T | undefined {
    const index = this.pending.findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = this.pending.splice(index, 1); this.changed(); return item;
  }
  clearPending(): void { this.pending = []; this.changed(); }
}

export type QueuedPromptRequest = {
  displayText?: string;
  clientRequestId?: string;
  sessionId: string;
  text: string;
  model?: { providerID: string; modelID: string; variant?: string };
  attachments?: { path: string; name: string; mime: string; size?: number }[];
  contextPaths?: string[];
  planMode?: boolean;
  effort?: string;
  command?: { name: string; args: string };
};
