import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

type Handler<E> = (event: E, ...args: any[]) => any;
/** Explicit routing is limited to channels registered as workspace operations.
 * The legacy path captures selection at entry, before asynchronous preparation.
 */
export class WorkspaceIpc<E = unknown> {
  private handlers = new Map<string, Handler<E>>();
  constructor(private registry: WorkspaceRegistry, private selected: () => WorkspaceLease | null) {}
  register(channel: string, handler: Handler<E>): void {
    if (this.handlers.has(channel)) throw new Error("Canal de workspace já registrado.");
    this.handlers.set(channel, handler);
  }
  invoke(lease: WorkspaceLease, channel: string, event: E, args: unknown[]): any {
    this.registry.assertLive(lease);
    const handler = this.handlers.get(channel);
    if (!handler || !Array.isArray(args)) throw new Error("Operação de workspace inválida.");
    return this.registry.run(lease, () => handler(event, ...args));
  }
  current(channel: string, event: E, args: unknown[]): any {
    const lease = this.registry.hasContext() ? this.registry.contextLease() : this.selected();
    if (lease) return this.invoke(lease, channel, event, args);
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error("Operação de workspace inválida.");
    return handler(event, ...args);
  }
}
