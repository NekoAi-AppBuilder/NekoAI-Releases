import type { WorkspaceLease, WorkspaceRegistry } from "./workspace-registry";

export interface WorkspaceSurface { setVisible(visible: boolean): void }
interface SurfaceEntry { lease: WorkspaceLease; surface: WorkspaceSurface; requested: boolean; overlay: boolean }

/** Selection changes visibility only. It never resizes, reloads or reparents the
 * retained native surface, so project UI and page geometry remain intact.
 */
export class WorkspaceVisibility {
  private entries = new Map<string, SurfaceEntry>();
  private selected: WorkspaceLease | null = null;
  constructor(private registry: WorkspaceRegistry) {}

  select(lease: WorkspaceLease | null): void {
    if (lease) this.registry.assertLive(lease);
    this.selected = lease;
    for (const entry of this.entries.values()) this.apply(entry);
  }
  track(lease: WorkspaceLease, surface: WorkspaceSurface): void {
    this.registry.assertLive(lease);
    const previous = this.entries.get(lease.workspaceId);
    if (previous && previous.surface !== surface) throw new Error("O workspace já possui uma superfície de Preview.");
    const entry = previous || { lease, surface, requested: false, overlay: false };
    this.entries.set(lease.workspaceId, entry);
    this.apply(entry);
  }
  request(lease: WorkspaceLease, visible: boolean): void {
    this.registry.assertLive(lease);
    const entry = this.entries.get(lease.workspaceId);
    if (!entry) return;
    entry.requested = visible; this.apply(entry);
  }
  overlay(lease: WorkspaceLease, active: boolean): void {
    this.registry.assertLive(lease);
    const entry = this.entries.get(lease.workspaceId);
    if (!entry) return;
    entry.overlay = active; this.apply(entry);
  }
  forget(lease: WorkspaceLease, surface: WorkspaceSurface): void {
    const entry = this.entries.get(lease.workspaceId);
    if (entry?.surface === surface && entry.lease.generation === lease.generation) {
      surface.setVisible(false); this.entries.delete(lease.workspaceId);
    }
  }
  private apply(entry: SurfaceEntry): void {
    let live = true;
    try { this.registry.assertLive(entry.lease); } catch { live = false; }
    const selected = this.selected?.workspaceId === entry.lease.workspaceId && this.selected.generation === entry.lease.generation;
    entry.surface.setVisible(live && selected && entry.requested && !entry.overlay);
  }
}
