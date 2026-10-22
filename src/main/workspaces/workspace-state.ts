import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

/** State buckets are independent of the selected tab. A closed async scope must
 * fail, rather than silently fall back to the newly selected workspace.
 */
export class WorkspaceState<S> {
  private states = new Map<string, S>();
  private bootstrap: S;
  constructor(private registry: WorkspaceRegistry, private factory: () => S, private selected: () => WorkspaceLease | null) {
    this.bootstrap = factory();
  }
  get(lease: WorkspaceLease): S {
    this.registry.assertLive(lease);
    let state = this.states.get(lease.workspaceId);
    if (!state) { state = this.factory(); this.states.set(lease.workspaceId, state); }
    return state;
  }
  current(): S {
    const lease = this.registry.hasContext() ? this.registry.contextLease() : this.selected();
    return lease ? this.get(lease) : this.bootstrap;
  }
  discard(lease: WorkspaceLease): void {
    try { this.registry.assertLive(lease); }
    catch { this.states.delete(lease.workspaceId); return; }
    throw new Error("Invalide o workspace antes de remover seu estado.");
  }
}

/** Existing collection call sites can migrate without snapshotting a selected
 * project's Map at module initialization. Methods and iterators bind to the
 * collection belonging to the async scope at access time.
 */
export function scopedCollection<C extends Map<any, any> | Set<any>>(resolve: () => C): C {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      const collection = resolve();
      const value = Reflect.get(collection, property, collection);
      return typeof value === "function" ? value.bind(collection) : value;
    }
  }) as C;
}

export function scopedFields<S extends object>(resolve: () => S): S {
  return new Proxy({} as S, {
    get(_target, property) { return Reflect.get(resolve(), property); },
    set(_target, property, value) { return Reflect.set(resolve(), property, value); }
  });
}
