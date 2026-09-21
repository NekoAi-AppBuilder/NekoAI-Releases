import React from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Loader2,
  Square,
  Sparkles,
  X,
  XCircle
} from "lucide-react";

export type TimelineItemType =
  | "thinking"
  | "analysis"
  | "read"
  | "edit"
  | "command"
  | "permission"
  | "question"
  | "validation"
  | "error"
  | "status";

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  title: string;
  detail?: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  sessionId?: string;
  taskId?: string;
  children?: TimelineItem[];
}

export interface TaskTimeline {
  taskId: string;
  sessionId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  items: TimelineItem[];
  summaryText?: string;
  error?: string;
}

interface PhaseGroup {
  id: string;
  name: string;
  description?: string;
  icon: "thinking" | "audit" | "implementation" | "validation" | "interaction" | "error" | "done";
  status: "pending" | "running" | "completed" | "error";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  items: TimelineItem[];
}

interface TimelineViewProps {
  timeline?: TaskTimeline | null;
  onBack: () => void;
  isTaskRunning?: boolean;
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const sec = ms / 1000;
  if (sec < 1) return `${Math.round(ms)}ms`;
  if (sec < 60) return `${sec.toFixed(1).replace(/\.0$/, "")}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("pt-BR", { hour12: false });
  } catch {
    return "";
  }
}

export function groupTimelineIntoPhases(items: TimelineItem[], taskStatus?: string, taskStartedAt?: number, taskCompletedAt?: number): PhaseGroup[] {
  const phases: PhaseGroup[] = [];

  // 1. Coleta e deduplica semanticamente itens idênticos consecutivos
  const deduplicatedItems: TimelineItem[] = [];
  for (const item of items) {
    const prev = deduplicatedItems[deduplicatedItems.length - 1];
    if (
      prev &&
      prev.type === item.type &&
      prev.title === item.title &&
      (prev.detail || "") === (item.detail || "")
    ) {
      // Atualiza o item anterior com os tempos e status mais recentes
      if (item.completedAt && (!prev.completedAt || item.completedAt > prev.completedAt)) {
        prev.completedAt = item.completedAt;
        prev.durationMs = prev.completedAt && prev.startedAt ? prev.completedAt - prev.startedAt : prev.durationMs;
      }
      if (item.status === "error") prev.status = "error";
      else if (item.status === "completed" && prev.status === "running") prev.status = "completed";
      continue;
    }
    deduplicatedItems.push({ ...item });
  }

  const thinkingItems: TimelineItem[] = [];
  const auditItems: TimelineItem[] = [];
  const implementationItems: TimelineItem[] = [];
  const validationItems: TimelineItem[] = [];
  const interactionItems: TimelineItem[] = [];
  const errorItems: TimelineItem[] = [];

  for (const item of deduplicatedItems) {
    if (item.type === "thinking") {
      thinkingItems.push(item);
    } else if (item.type === "read" || item.type === "analysis") {
      auditItems.push(item);
    } else if (item.type === "edit") {
      implementationItems.push(item);
    } else if (item.type === "validation") {
      validationItems.push(item);
    } else if (item.type === "command") {
      const lower = (item.detail || item.title || "").toLowerCase();
      if (/\b(build|test|vitest|jest|tsc|lint|preview|check)\b/.test(lower)) {
        validationItems.push(item);
      } else {
        implementationItems.push(item);
      }
    } else if (item.type === "permission" || item.type === "question") {
      interactionItems.push(item);
    } else if (item.type === "error") {
      errorItems.push(item);
    } else {
      const lower = (item.title || "").toLowerCase();
      if (lower.includes("lendo") || lower.includes("analisando") || lower.includes("procurando")) {
        auditItems.push(item);
      } else if (lower.includes("editando") || lower.includes("criando") || lower.includes("alterado")) {
        implementationItems.push(item);
      } else {
        implementationItems.push(item);
      }
    }
  }

  // 1. Fase de Pensamento & Análise
  if (thinkingItems.length > 0) {
    const isRunning = thinkingItems.some(i => i.status === "running");
    const hasError = thinkingItems.some(i => i.status === "error");
    const started = Math.min(...thinkingItems.map(i => i.startedAt));
    const completed = thinkingItems.every(i => i.completedAt) ? Math.max(...thinkingItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-thinking",
      name: "Pensamento & Análise",
      description: dur ? `Pensou por ${formatDuration(dur)}` : "Analisando a solicitação e contexto",
      icon: "thinking",
      status: isRunning ? "running" : hasError ? "error" : "completed",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: thinkingItems
    });
  }

  // 2. Fase de Auditoria de Implementação
  if (auditItems.length > 0) {
    const isRunning = auditItems.some(i => i.status === "running");
    const hasError = auditItems.some(i => i.status === "error");
    const started = Math.min(...auditItems.map(i => i.startedAt));
    const completed = auditItems.every(i => i.completedAt) ? Math.max(...auditItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-audit",
      name: "Auditoria de Implementação",
      description: `${auditItems.length} arquivo${auditItems.length > 1 ? "s" : ""} analisado${auditItems.length > 1 ? "s" : ""}`,
      icon: "audit",
      status: isRunning ? "running" : hasError ? "error" : "completed",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: auditItems
    });
  }

  // 3. Fase de Implementação
  if (implementationItems.length > 0) {
    const isRunning = implementationItems.some(i => i.status === "running");
    const hasError = implementationItems.some(i => i.status === "error");
    const started = Math.min(...implementationItems.map(i => i.startedAt));
    const completed = implementationItems.every(i => i.completedAt) ? Math.max(...implementationItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-implementation",
      name: "Implementação",
      description: `${implementationItems.length} alteraç${implementationItems.length > 1 ? "ões" : "ão"} no projeto`,
      icon: "implementation",
      status: isRunning ? "running" : hasError ? "error" : "completed",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: implementationItems
    });
  }

  // 4. Fase de Autorizações & Interações
  if (interactionItems.length > 0) {
    const isRunning = interactionItems.some(i => i.status === "running");
    const hasError = interactionItems.some(i => i.status === "error");
    const started = Math.min(...interactionItems.map(i => i.startedAt));
    const completed = interactionItems.every(i => i.completedAt) ? Math.max(...interactionItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-interaction",
      name: "Autorizações & Interações",
      description: "Autorizações e decisões respondidas",
      icon: "interaction",
      status: isRunning ? "running" : hasError ? "error" : "completed",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: interactionItems
    });
  }

  // 5. Fase de Validação & Build
  if (validationItems.length > 0) {
    const isRunning = validationItems.some(i => i.status === "running");
    const hasError = validationItems.some(i => i.status === "error");
    const started = Math.min(...validationItems.map(i => i.startedAt));
    const completed = validationItems.every(i => i.completedAt) ? Math.max(...validationItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-validation",
      name: "Validação & Build",
      description: "Verificação de compilação e preview",
      icon: "validation",
      status: isRunning ? "running" : hasError ? "error" : "completed",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: validationItems
    });
  }

  // 6. Fase de Diagnóstico & Ajustes
  if (errorItems.length > 0) {
    const isRunning = errorItems.some(i => i.status === "running");
    const started = Math.min(...errorItems.map(i => i.startedAt));
    const completed = errorItems.every(i => i.completedAt) ? Math.max(...errorItems.map(i => i.completedAt!)) : undefined;
    const dur = completed && started ? completed - started : undefined;

    phases.push({
      id: "phase-error",
      name: "Diagnóstico & Ajustes",
      description: "Correções automáticas e recuperação",
      icon: "error",
      status: isRunning ? "running" : "error",
      startedAt: started,
      completedAt: completed,
      durationMs: dur,
      items: errorItems
    });
  }

  return phases;
}

export function TimelineView({ timeline, onBack, isTaskRunning }: TimelineViewProps) {
  const [collapsedPhases, setCollapsedPhases] = React.useState<Record<string, boolean>>({});

  const togglePhase = (phaseId: string) => {
    setCollapsedPhases(prev => ({ ...prev, [phaseId]: !prev[phaseId] }));
  };

  const items = timeline?.items ?? [];
  const phases = React.useMemo(() => {
    return groupTimelineIntoPhases(items, timeline?.status, timeline?.startedAt, timeline?.completedAt);
  }, [items, timeline?.status, timeline?.startedAt, timeline?.completedAt]);

  const totalDuration = timeline?.durationMs ?? (timeline?.completedAt && timeline?.startedAt ? timeline.completedAt - timeline.startedAt : undefined);
  const isRunning = isTaskRunning || timeline?.status === "running";
  const isCancelled = timeline?.status === "cancelled";
  const isFailed = timeline?.status === "failed";
  const isCompleted = timeline?.status === "completed";
  const isQuotaError = Boolean(timeline?.error && /quota|crédito|limite|saldo|credit/i.test(timeline.error));

  return (
    <div className="timeline-view-container" role="region" aria-label="Timeline de execução do Agent">
      {/* Top Header Bar */}
      <header className="timeline-header">
        <button
          type="button"
          className="timeline-back-btn"
          onClick={onBack}
          aria-label="Voltar para o Preview"
          title="Voltar para a visualização do Preview"
        >
          <ArrowLeft size={15} />
          <span>Voltar para o Preview</span>
        </button>

        <div className="timeline-header-meta">
          {timeline?.taskId && (
            <span className="timeline-task-badge" title={`Tarefa ${timeline.taskId}`}>
              #{timeline.taskId.slice(-8)}
            </span>
          )}

          {totalDuration !== undefined && totalDuration > 0 && (
            <span className="timeline-duration-badge" title="Duração total da tarefa">
              <Clock size={12} />
              <span>{formatDuration(totalDuration)}</span>
            </span>
          )}

          <span className={`timeline-status-tag ${isRunning ? "running" : isCancelled ? "cancelled" : isFailed ? "failed" : isCompleted ? "completed" : "idle"}`}>
            {isRunning && <Loader2 size={11} className="spin" />}
            {isCompleted && <Check size={11} />}
            {isFailed && <X size={11} />}
            {isCancelled && <Square size={10} fill="currentColor" />}
            <span>
              {isRunning
                ? "Em execução"
                : isCancelled
                ? "Cancelada pelo usuário"
                : isQuotaError
                ? "Limite de uso ou cota excedida"
                : isFailed
                ? "Execução com erro"
                : isCompleted
                ? "Concluída"
                : "Aguardando"}
            </span>
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="timeline-body">
        {phases.length === 0 ? (
          <div className="timeline-empty-state">
            <div className="timeline-empty-icon">
              {isRunning ? <Loader2 size={24} className="spin" /> : <Sparkles size={24} />}
            </div>
            <strong>{isRunning ? "Neko inicializando a execução..." : "Nenhuma atividade registrada."}</strong>
            <span>{isRunning ? "As etapas e arquivos analisados aparecerão aqui em tempo real." : "Envie uma tarefa no chat para acompanhar a timeline de execução."}</span>
          </div>
        ) : (
          <div className="timeline-tree-root">
            {/* Timeline Task Header Node */}
            <div className="timeline-tree-node task-node">
              <div className="timeline-node-marker root-marker">
                {isRunning ? (
                  <div className="pulse-dot" />
                ) : isCancelled ? (
                  <Square size={13} fill="currentColor" className="text-warning" />
                ) : isFailed ? (
                  <XCircle size={16} className="text-danger" />
                ) : (
                  <CheckCircle2 size={16} className="text-success" />
                )}
              </div>
              <div className="timeline-node-content">
                <div className="timeline-node-header">
                  <strong className="timeline-node-title">
                    {timeline?.summaryText ||
                      (isRunning
                        ? "Executando tarefa..."
                        : isCancelled
                        ? "Execução cancelada pelo usuário"
                        : isQuotaError
                        ? "Limite de uso ou cota excedida"
                        : isFailed
                        ? "Execução com erro"
                        : "Tarefa concluída com sucesso")}
                  </strong>
                  {timeline?.startedAt && (
                    <span className="timeline-node-time">{formatTimestamp(timeline.startedAt)}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Render Phases */}
            {phases.map((phase) => {
              const isCollapsed = Boolean(collapsedPhases[phase.id]);

              return (
                <div key={phase.id} className={`timeline-phase-block ${phase.status} ${isCollapsed ? "collapsed" : ""}`}>
                  {/* Phase Header Node */}
                  <div
                    className="timeline-tree-node phase-node"
                    onClick={() => togglePhase(phase.id)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={!isCollapsed}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        togglePhase(phase.id);
                      }
                    }}
                  >
                    <div className="timeline-node-marker phase-marker">
                      {phase.status === "running" ? (
                        <Loader2 size={14} className="spin text-accent" />
                      ) : phase.status === "error" ? (
                        <X size={14} className="text-danger" />
                      ) : (
                        <Check size={14} className="text-success" />
                      )}
                    </div>

                    <div className="timeline-node-content">
                      <div className="timeline-phase-header-row">
                        <div className="timeline-phase-title-wrap">
                          <span className="timeline-phase-name">{phase.name}</span>
                          {phase.description && (
                            <span className="timeline-phase-desc">{phase.description}</span>
                          )}
                        </div>

                        <div className="timeline-phase-meta">
                          {phase.durationMs !== undefined && phase.durationMs > 0 && (
                            <span className="timeline-phase-duration">{formatDuration(phase.durationMs)}</span>
                          )}
                          <button type="button" className="timeline-phase-collapse-btn" aria-label={isCollapsed ? "Expandir" : "Recolher"}>
                            <ChevronDown size={14} className={`phase-caret ${isCollapsed ? "rotated" : ""}`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Phase Items Tree (when expanded) */}
                  {!isCollapsed && (
                    <div className="timeline-phase-items">
                      {phase.items.map((item, itemIdx) => {
                        const isLastItem = itemIdx === phase.items.length - 1;
                        const itemDur = item.durationMs ?? (item.completedAt && item.startedAt ? item.completedAt - item.startedAt : undefined);

                        return (
                          <div key={item.id || `item-${itemIdx}`} className={`timeline-item-row ${item.status}`}>
                            <div className="timeline-tree-branch">
                              <span className="branch-char">{isLastItem ? "└─" : "├─"}</span>
                            </div>

                            <div className="timeline-item-status-icon">
                              {item.status === "running" ? (
                                <Loader2 size={12} className="spin text-accent" />
                              ) : item.status === "error" ? (
                                <X size={12} className="text-danger" />
                              ) : (
                                <Check size={12} className="text-success" />
                              )}
                            </div>

                            <div className="timeline-item-body">
                              <span className="timeline-item-title">{item.title}</span>
                              {item.detail && item.detail !== item.title && (
                                <span className="timeline-item-detail" title={item.detail}>
                                  {item.detail}
                                </span>
                              )}
                            </div>

                            {itemDur !== undefined && itemDur > 0 && (
                              <span className="timeline-item-duration">{formatDuration(itemDur)}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Concluded Final Node */}
            {!isRunning && (
              <div className={`timeline-tree-node conclusion-node ${isCancelled ? "cancelled" : isFailed ? "failed" : "completed"}`}>
                <div className="timeline-node-marker root-marker">
                  {isCancelled ? (
                    <Square size={13} fill="currentColor" className="text-warning" />
                  ) : isFailed ? (
                    <XCircle size={15} className="text-danger" />
                  ) : (
                    <CheckCircle2 size={15} className="text-success" />
                  )}
                </div>
                <div className="timeline-node-content">
                  <div className="timeline-node-header">
                    <strong className="timeline-node-title">
                      {isCancelled
                        ? "Execução cancelada pelo usuário."
                        : isQuotaError
                        ? (timeline?.error || "Limite de uso ou cota excedida.")
                        : isFailed
                        ? (timeline?.error || "Execução com erro.")
                        : "Concluído com sucesso."}
                    </strong>
                    {timeline?.completedAt && (
                      <span className="timeline-node-time">{formatTimestamp(timeline.completedAt)}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
