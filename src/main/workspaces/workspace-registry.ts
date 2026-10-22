import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WorkspaceLease {
  readonly workspaceId: string;
  readonly generation: number;
}
export interface WorkspaceDescriptor extends WorkspaceLease {
  readonly projectPath: string;
  readonly projectKey: string;
  readonly sessionIds: readonly string[];
}
interface Entry extends WorkspaceLease {
  projectPath: string;
  projectKey: string;
  sessions: Set<string>;
}

/** Live runtime identities, deliberately independent of conversation history.
 * Selecting a workspace never disposes another one. Closing explicitly invalidates
 * leases so late asynchronous callbacks cannot target a reopened instance.
 */
export class WorkspaceRegistry {
  private entries = new Map<string, Entry>();
  private paths = new Map<string, string>();
  private owners = new Map<string, string>();
  private generations = new Map<string, number>();
  private scope = new AsyncLocalStorage<WorkspaceLease | null>();

  constructor(private canonicalPath: (value: string) => string = value => fs.realpathSync.native(value)) {}

  private identify(projectPath: string): { projectPath: string; projectKey: string } {
    if (!projectPath.trim()) throw new Error("Pasta do projeto não informada.");
    const canonical = path.normalize(this.canonicalPath(path.resolve(projectPath)));
    const root = path.parse(canonical).root;
    const normalized = canonical.length > root.length ? canonical.replace(/[\\/]+$/, "") : canonical;
    return { projectPath: normalized, projectKey: process.platform === "win32" ? normalized.toLowerCase() : normalized };
  }

  open(projectPath: string): WorkspaceDescriptor {
    const identity = this.identify(projectPath);
    const existing = this.paths.get(identity.projectKey);
    if (existing) return this.get(existing);
    const generation = (this.generations.get(identity.projectKey) || 0) + 1;
    this.generations.set(identity.projectKey, generation);
    const entry: Entry = { ...identity, workspaceId: randomUUID(), generation, sessions: new Set() };
    this.entries.set(entry.workspaceId, entry);
    this.paths.set(entry.projectKey, entry.workspaceId);
    return this.get(entry.workspaceId);
  }

  get(workspaceId: string): WorkspaceDescriptor {
    const entry = this.entries.get(workspaceId);
    if (!entry) throw new Error("O workspace foi encerrado ou não existe.");
    return Object.freeze({ workspaceId: entry.workspaceId, generation: entry.generation, projectPath: entry.projectPath, projectKey: entry.projectKey, sessionIds: Object.freeze([...entry.sessions]) });
  }

  forSession(sessionId: string): WorkspaceDescriptor {
    const owner = this.owners.get(sessionId);
    if (!owner) throw new Error("A sessão não pertence a um workspace aberto.");
    return this.get(owner);
  }

  list(): readonly WorkspaceDescriptor[] { return [...this.entries.keys()].map(id => this.get(id)); }

  assertLive(lease: WorkspaceLease): WorkspaceDescriptor {
    const entry = this.get(lease.workspaceId);
    if (entry.generation !== lease.generation) throw new Error("A operação pertence a uma instância anterior do projeto.");
    return entry;
  }

  bindSession(lease: WorkspaceLease, sessionId: string): void {
    this.assertLive(lease);
    if (!sessionId.trim()) throw new Error("Sessão não informada.");
    const owner = this.owners.get(sessionId);
    if (owner && owner !== lease.workspaceId) throw new Error("A sessão pertence a outro projeto.");
    this.entries.get(lease.workspaceId)!.sessions.add(sessionId);
    this.owners.set(sessionId, lease.workspaceId);
  }

  assertSession(lease: WorkspaceLease, sessionId: string): WorkspaceDescriptor {
    const entry = this.assertLive(lease);
    if (this.owners.get(sessionId) !== lease.workspaceId) throw new Error("A sessão não pertence a este projeto.");
    return entry;
  }

  run<T>(lease: WorkspaceLease, operation: () => T): T {
    this.assertLive(lease);
    return this.scope.run(Object.freeze({ workspaceId: lease.workspaceId, generation: lease.generation }), operation);
  }

  hasContext(): boolean { return this.scope.getStore() !== undefined; }
  runBootstrap<T>(operation: () => T): T { return this.scope.run(null, operation); }
  contextLease(): WorkspaceLease | undefined { return this.scope.getStore() ?? undefined; }

  current(): WorkspaceDescriptor {
    const lease = this.scope.getStore();
    if (!lease) throw new Error("Operação sem workspace explícito.");
    return this.assertLive(lease);
  }

  close(lease: WorkspaceLease): void {
    this.assertLive(lease);
    const entry = this.entries.get(lease.workspaceId)!;
    for (const sessionId of entry.sessions) this.owners.delete(sessionId);
    this.paths.delete(entry.projectKey);
    this.entries.delete(entry.workspaceId);
  }
}
