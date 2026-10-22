import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

export type WorkspaceResourceKind = "preview-view" | "engine" | "preview-process" | "preview-server" | "event-stream" | "watcher";
interface Resource {
  identity: object;
  dispose: () => void | Promise<void>;
  pending?: Promise<void>;
}
interface Group {
  lease: WorkspaceLease;
  state: "open" | "closing" | "closed";
  resources: Map<WorkspaceResourceKind, Resource>;
  pending?: Promise<void>;
}

/** Owns concrete resource handles, never pointers to whichever project is selected.
 * Disposal is idempotent and concurrent close calls share the same operation.
 * A failed disposal stays registered so shutdown can retry it.
 */
export class WorkspaceResources {
  private groups = new Map<string, Group>();
  private owners = new WeakMap<object, { workspaceId: string; kind: WorkspaceResourceKind }>();
  constructor(private registry: WorkspaceRegistry) {}

  track(lease: WorkspaceLease, kind: WorkspaceResourceKind, identity: object, dispose: () => void | Promise<void>): void {
    this.registry.assertLive(lease);
    let group = this.groups.get(lease.workspaceId);
    if (!group) {
      group = { lease: Object.freeze({ ...lease }), state: "open", resources: new Map() };
      this.groups.set(lease.workspaceId, group);
    }
    if (group.lease.generation !== lease.generation || group.state !== "open") throw new Error("O workspace está sendo encerrado.");
    const owner = this.owners.get(identity);
    if (owner && (owner.workspaceId !== lease.workspaceId || owner.kind !== kind)) throw new Error("O recurso já pertence a outro workspace ou serviço.");
    const existing = group.resources.get(kind);
    if (existing?.identity === identity) return;
    if (existing) throw new Error(`O recurso ${kind} anterior ainda não foi liberado.`);
    group.resources.set(kind, { identity, dispose });
    this.owners.set(identity, { workspaceId: lease.workspaceId, kind });
  }

  /** Called only after a resource actually exited/closed. Stale callbacks cannot
   * remove a replacement with the same resource kind.
   */
  forget(lease: WorkspaceLease, kind: WorkspaceResourceKind, identity: object): boolean {
    const group = this.groups.get(lease.workspaceId);
    if (!group || group.lease.generation !== lease.generation) return false;
    if (group.resources.get(kind)?.identity !== identity) return false;
    this.owners.delete(identity);
    return group.resources.delete(kind);
  }

  private disposeOne(group: Group, kind: WorkspaceResourceKind, resource: Resource): Promise<void> {
    if (resource.pending) return resource.pending;
    const pending = Promise.resolve().then(resource.dispose).then(() => {
      if (group.resources.get(kind) === resource) {
        group.resources.delete(kind);
        this.owners.delete(resource.identity);
      }
    }).finally(() => { resource.pending = undefined; });
    resource.pending = pending;
    return pending;
  }

  release(lease: WorkspaceLease, kind: WorkspaceResourceKind, identity: object): Promise<void> {
    const group = this.groups.get(lease.workspaceId);
    if (!group || group.lease.generation !== lease.generation) return Promise.resolve();
    const resource = group.resources.get(kind);
    if (!resource || resource.identity !== identity) return Promise.resolve();
    return this.disposeOne(group, kind, resource);
  }

  close(lease: WorkspaceLease): Promise<void> {
    const group = this.groups.get(lease.workspaceId);
    if (!group) return Promise.resolve();
    if (group.lease.generation !== lease.generation) return Promise.reject(new Error("Instância de workspace inválida."));
    if (group.pending) return group.pending;
    if (group.state === "closed") return Promise.resolve();
    group.state = "closing";
    // Stop event producers before the processes they observe.
    const order: WorkspaceResourceKind[] = ["preview-view", "event-stream", "watcher", "preview-server", "preview-process", "engine"];
    const pending = (async () => {
      const errors: unknown[] = [];
      for (const kind of order) {
        const resource = group.resources.get(kind);
        if (!resource) continue;
        try { await this.disposeOne(group, kind, resource); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Não foi possível liberar todos os recursos do projeto.");
      group.state = "closed";
    })().finally(() => { group.pending = undefined; });
    group.pending = pending;
    return pending;
  }

  describe(lease: WorkspaceLease): { state: "open" | "closing" | "closed"; resources: readonly WorkspaceResourceKind[] } {
    const group = this.groups.get(lease.workspaceId);
    if (!group || group.lease.generation !== lease.generation) return { state: "closed", resources: [] };
    return { state: group.state, resources: [...group.resources.keys()] };
  }

  /** Remove the closed bookkeeping only after registry invalidation. */
  retire(lease: WorkspaceLease): void {
    const group = this.groups.get(lease.workspaceId);
    if (!group || group.lease.generation !== lease.generation) return;
    if (group.state !== "closed" || group.resources.size) throw new Error("O projeto ainda possui recursos ativos.");
    try { this.registry.assertLive(lease); } catch { this.groups.delete(lease.workspaceId); return; }
    throw new Error("Invalide o workspace antes de remover seu registro de recursos.");
  }
}
