import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

export interface WorkspaceServiceTarget extends WorkspaceLease {
  readonly serviceGeneration: number;
  readonly projectPath: string;
  readonly engineUrl: string;
}

/** Immutable addresses for per-project engines. Never resolves a request through
 * whichever project happens to be selected after an await.
 */
export class WorkspaceServices {
  private targets = new Map<string, WorkspaceServiceTarget>();
  private sequence = 0;

  constructor(private registry: WorkspaceRegistry) {}

  attach(lease: WorkspaceLease, engineUrl: string): WorkspaceServiceTarget {
    const workspace = this.registry.assertLive(lease);
    const url = new URL(engineUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("O serviço do workspace deve usar uma origem HTTP local.");
    }
    for (const existing of this.targets.values()) {
      if (existing.workspaceId !== lease.workspaceId && existing.engineUrl === url.origin) {
        throw new Error("Este serviço já pertence a outro workspace.");
      }
    }
    const target = Object.freeze({ workspaceId: lease.workspaceId, generation: lease.generation,
      projectPath: workspace.projectPath, engineUrl: url.origin, serviceGeneration: ++this.sequence });
    this.targets.set(lease.workspaceId, target);
    return target;
  }

  capture(lease: WorkspaceLease): WorkspaceServiceTarget {
    this.registry.assertLive(lease);
    const target = this.targets.get(lease.workspaceId);
    if (!target) throw new Error("O serviço deste projeto ainda não está disponível.");
    this.assertCurrent(target);
    return target;
  }

  assertCurrent(target: WorkspaceServiceTarget): void {
    this.registry.assertLive(target);
    const current = this.targets.get(target.workspaceId);
    if (!current || current !== target || current.serviceGeneration !== target.serviceGeneration) {
      throw new Error("O serviço deste projeto foi encerrado ou reiniciado.");
    }
  }

  detach(lease: WorkspaceLease): void {
    this.registry.assertLive(lease);
    this.targets.delete(lease.workspaceId);
  }

  headers(target: WorkspaceServiceTarget, authentication: Record<string, string> = {}): Record<string, string> {
    this.assertCurrent(target);
    return { ...authentication, "x-opencode-directory": encodeURIComponent(target.projectPath) };
  }

  async request(target: WorkspaceServiceTarget, endpoint: string, init: RequestInit = {}, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
    this.assertCurrent(target);
    if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("\\")) {
      throw new Error("Rota inválida para o serviço do workspace.");
    }
    const url = new URL(endpoint, target.engineUrl);
    if (url.origin !== target.engineUrl) throw new Error("A rota não pertence ao serviço do workspace.");
    const headers = new Headers(init.headers);
    headers.set("x-opencode-directory", encodeURIComponent(target.projectPath));
    const response = await fetcher(url.toString(), { ...init, headers });
    this.assertCurrent(target);
    return response;
  }

  async use<T>(lease: WorkspaceLease, operation: (target: WorkspaceServiceTarget) => Promise<T>): Promise<T> {
    const target = this.capture(lease);
    const result = await operation(target);
    this.assertCurrent(target);
    return result;
  }
}
