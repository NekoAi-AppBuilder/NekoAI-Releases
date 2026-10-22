import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

export class WorkspaceEvents {
  constructor(private registry: WorkspaceRegistry) {}
  accept(lease: WorkspaceLease, event: any): void {
    this.registry.assertLive(lease);
    const props = event?.properties || {};
    if (props.workspaceId && props.workspaceId !== lease.workspaceId) throw new Error("Evento pertence a outro workspace.");
    if (props.workspaceGeneration !== undefined && props.workspaceGeneration !== lease.generation) throw new Error("Evento pertence a uma instância anterior do workspace.");
    const info = props.info ?? props;
    const parentId = (event?.type === "session.created" || event?.type === "session.updated") ? String(info.parentID ?? info.parentId ?? "") : "";
    if (parentId) {
      let parentOwner;
      try { parentOwner = this.registry.forSession(parentId); } catch {}
      if (parentOwner && parentOwner.workspaceId !== lease.workspaceId) throw new Error("A sessão pai pertence a outro workspace.");
    }
    const infoSessionId = (event?.type === "session.created" || event?.type === "session.updated") ? info.id : undefined;
    const sessionId = String(props.sessionID ?? props.sessionId ?? props.session?.id ?? event?.sessionID ?? event?.sessionId ?? infoSessionId ?? "");
    if (sessionId) {
      let owner;
      try { owner = this.registry.forSession(sessionId); } catch { return; }
      if (owner.workspaceId !== lease.workspaceId) throw new Error("Evento de sessão recebido pelo workspace errado.");
    }
  }
  envelope(lease: WorkspaceLease, event: any): any {
    this.accept(lease, event);
    return { ...event, properties: { ...event?.properties, workspaceId: lease.workspaceId, workspaceGeneration: lease.generation } };
  }
}
