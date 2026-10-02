/**
 * NekoAI Notification System
 * 
 * Infraestrutura padronizada de notificações globais e feedback contextual:
 * 1. Notificações Globais:
 *    - 4 variantes: success, warning, error, info
 *    - Duração fixa: 8 segundos para todos os tipos
 *    - Barra de progresso animada no rodapé (100% -> 0%) sincronizada com o timer
 *    - Regra estrita de hover: pausa o timer E a animação no ponto exato;
 *      mouseleave retoma de onde parou sem resetar os 8 segundos
 *    - Fechamento manual imediato via botão X
 *    - Apenas UMA notificação global visível por vez (substituição limpa, sem empilhamento)
 * 2. Feedback Contextual:
 *    - Próximo ao elemento de origem (ex: "Copiado!", "Tarefa desfeita")
 *    - Comportamento e ciclo de vida completamente independentes do Toast global
 */

export type NotificationType = "success" | "warning" | "error" | "info";

export interface GlobalNotificationOptions {
  message: string;
  type?: NotificationType;
  title?: string;
  durationMs?: number;
}

export interface GlobalNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  durationMs: number;
  createdAt: number;
}

export interface ContextualFeedback {
  id: string;
  message: string;
  left: number;
  top: number;
}

export const GLOBAL_TOAST_DURATION_MS = 8000;
export const CONTEXTUAL_FEEDBACK_DURATION_MS = 1800;

/**
 * Inferência automática de tipo e título para chamadas legadas de showToast("mensagem")
 */
export function inferNotificationType(message: string): { type: NotificationType; title: string } {
  const lower = (message || "").toLowerCase();

  // Erros
  if (
    lower.includes("erro") ||
    lower.includes("falha") ||
    lower.includes("não foi possível") ||
    lower.includes("falhou") ||
    lower.includes("inválid") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("não pode") ||
    lower.includes("não existe mais") ||
    lower.includes("recusad")
  ) {
    return { type: "error", title: "Erro" };
  }

  // Avisos / Atenção
  if (
    lower.includes("atenção") ||
    lower.includes("aviso") ||
    lower.includes("pausada") ||
    lower.includes("pausado") ||
    lower.includes("pendente") ||
    lower.includes("warning") ||
    lower.includes("precisa da sua atenção") ||
    lower.includes("conflito")
  ) {
    return { type: "warning", title: "Atenção" };
  }

  // Sucesso
  if (
    lower.includes("sucesso") ||
    lower.includes("salvo") ||
    lower.includes("concluíd") ||
    lower.includes("enviada") ||
    lower.includes("enviadas") ||
    lower.includes("criada") ||
    lower.includes("mesclada") ||
    lower.includes("conectado") ||
    lower.includes("sincronizado") ||
    lower.includes("sincronizadas") ||
    lower.includes("descartada") ||
    lower.includes("descartadas") ||
    lower.includes("atualizado") ||
    lower.includes("atualizada") ||
    lower.includes("alternado")
  ) {
    return { type: "success", title: "Sucesso" };
  }

  // Padrão informativo
  return { type: "info", title: "Informação" };
}

export interface ToastTimerOptions {
  durationMs?: number;
  onTick?: (progress: number, remainingMs: number) => void;
  onDismiss?: () => void;
}

/**
 * Controlador de Timer com Pause/Resume de Alta Precisão
 * Sincroniza estritamente a barra de progresso e o timer de fechamento
 */
export class ToastTimerController {
  private durationMs: number;
  private remainingMs: number;
  private isPausedState: boolean = false;
  private isRunningState: boolean = false;
  private isManualMode: boolean = false;
  private lastTimestamp: number = 0;
  private rafId: number | null = null;
  private timeoutId: any = null;
  private onTick?: (progress: number, remainingMs: number) => void;
  private onDismiss?: () => void;

  constructor(options?: ToastTimerOptions) {
    this.durationMs = options?.durationMs ?? GLOBAL_TOAST_DURATION_MS;
    this.remainingMs = this.durationMs;
    this.onTick = options?.onTick;
    this.onDismiss = options?.onDismiss;
  }

  public start(): void {
    if (this.isRunningState) return;
    this.isRunningState = true;
    this.isPausedState = false;
    this.lastTimestamp = this.now();
    this.notifyTick();
    this.scheduleNext();
  }

  public pause(): void {
    if (!this.isRunningState || this.isPausedState) return;
    if (!this.isManualMode) {
      const currentNow = this.now();
      const elapsed = Math.max(0, currentNow - this.lastTimestamp);
      this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    }
    this.isPausedState = true;
    this.cancelScheduled();
    this.notifyTick();
  }

  public resume(): void {
    if (!this.isRunningState || !this.isPausedState) return;
    this.isPausedState = false;
    this.lastTimestamp = this.now();
    this.notifyTick();
    if (!this.isManualMode) {
      this.scheduleNext();
    }
  }

  public stop(): void {
    this.isRunningState = false;
    this.isPausedState = false;
    this.cancelScheduled();
  }

  public getRemainingMs(): number {
    if (!this.isRunningState || this.isPausedState || this.isManualMode) {
      return this.remainingMs;
    }
    const currentNow = this.now();
    const elapsed = Math.max(0, currentNow - this.lastTimestamp);
    // Ignore microsecond precision jitter (< 1ms)
    if (elapsed < 1) return this.remainingMs;
    return Math.max(0, this.remainingMs - elapsed);
  }

  public getProgress(): number {
    return Math.max(0, Math.min(1, this.getRemainingMs() / this.durationMs));
  }

  public isPaused(): boolean {
    return this.isPausedState;
  }

  public isRunning(): boolean {
    return this.isRunningState;
  }

  /**
   * Método de avanço manual para testes ou ambientes sem relógio contínuo
   */
  public tick(deltaMs: number): void {
    if (!this.isRunningState || this.isPausedState) return;
    this.isManualMode = true;
    this.cancelScheduled();
    this.remainingMs = Math.max(0, this.remainingMs - deltaMs);
    this.notifyTick();
    if (this.remainingMs <= 0) {
      this.stop();
      this.onDismiss?.();
    }
  }

  private now(): number {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  private notifyTick(): void {
    this.onTick?.(this.getProgress(), this.getRemainingMs());
  }

  private scheduleNext(): void {
    this.cancelScheduled();
    if (!this.isRunningState || this.isPausedState) return;

    if (typeof requestAnimationFrame !== "undefined") {
      const loop = (now: number) => {
        if (!this.isRunningState || this.isPausedState) return;
        const elapsed = Math.max(0, now - this.lastTimestamp);
        this.lastTimestamp = now;
        this.remainingMs = Math.max(0, this.remainingMs - elapsed);
        this.notifyTick();

        if (this.remainingMs <= 0) {
          this.stop();
          this.onDismiss?.();
          return;
        }
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    } else {
      this.timeoutId = setTimeout(() => {
        if (!this.isRunningState || this.isPausedState) return;
        this.remainingMs = 0;
        this.notifyTick();
        this.stop();
        this.onDismiss?.();
      }, this.remainingMs);
    }
  }

  private cancelScheduled(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}

/**
 * Gerenciador Único de Notificações
 */
export class NotificationManager {
  private globalNotification: GlobalNotification | null = null;
  private contextualFeedback: ContextualFeedback | null = null;
  private activeGlobalTimer: ToastTimerController | null = null;
  private contextualTimer: any = null;
  private counter: number = 0;
  private listeners: Set<() => void> = new Set();

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[NotificationManager] Erro no listener:", err);
      }
    }
  }

  public getGlobalNotification(): GlobalNotification | null {
    return this.globalNotification;
  }

  public getContextualFeedback(): ContextualFeedback | null {
    return this.contextualFeedback;
  }

  public getActiveGlobalTimer(): ToastTimerController | null {
    return this.activeGlobalTimer;
  }

  /**
   * Exibe uma notificação global.
   * Regra 8: NÃO empilhar. Substitui qualquer notificação ativa imediatamente,
   * cancelando timers anteriores e iniciando um novo ciclo de 8 segundos.
   */
  public showGlobalNotification(options: GlobalNotificationOptions): GlobalNotification {
    // 1. Limpa timer e notificação anterior
    if (this.activeGlobalTimer) {
      this.activeGlobalTimer.stop();
      this.activeGlobalTimer = null;
    }

    // 2. Determina tipo e título
    const inferred = inferNotificationType(options.message);
    const type: NotificationType = options.type || inferred.type;
    const title = options.title || (
      type === "success" ? "Sucesso" :
      type === "warning" ? "Atenção" :
      type === "error" ? "Erro" : "Informação"
    );

    // 3. Duração estrita de 8 segundos (Regra 3)
    const durationMs = GLOBAL_TOAST_DURATION_MS;
    const id = `global-toast-${++this.counter}-${Date.now()}`;

    const notification: GlobalNotification = {
      id,
      type,
      title,
      message: options.message,
      durationMs,
      createdAt: Date.now(),
    };

    this.globalNotification = notification;
    this.notify();
    return notification;
  }

  /**
   * Vincula um controlador de timer à notificação ativa
   */
  public registerGlobalTimer(timer: ToastTimerController): void {
    this.activeGlobalTimer = timer;
  }

  /**
   * Fecha a notificação global imediatamente
   */
  public dismissGlobalNotification(id?: string): void {
    if (id && this.globalNotification && this.globalNotification.id !== id) {
      return;
    }
    if (this.activeGlobalTimer) {
      this.activeGlobalTimer.stop();
      this.activeGlobalTimer = null;
    }
    this.globalNotification = null;
    this.notify();
  }

  /**
   * Exibe feedback contextual próximo ao elemento que disparou a ação
   * Ciclo de vida e posição totalmente independentes do Toast global
   */
  public showContextualFeedback(
    message: string,
    target?: { getBoundingClientRect?: () => DOMRect } | { left: number; top: number } | null
  ): ContextualFeedback {
    if (this.contextualTimer) {
      clearTimeout(this.contextualTimer);
      this.contextualTimer = null;
    }

    let left = typeof window !== "undefined" ? window.innerWidth / 2 : 500;
    let top = 74;

    if (target && typeof (target as any).getBoundingClientRect === "function") {
      const rect = (target as any).getBoundingClientRect();
      const winWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
      const winHeight = typeof window !== "undefined" ? window.innerHeight : 768;
      left = Math.min(Math.max(rect.left + rect.width / 2, 70), winWidth - 70);
      top = Math.min(rect.bottom + 8, winHeight - 42);
    } else if (target && typeof (target as any).left === "number" && typeof (target as any).top === "number") {
      left = (target as any).left;
      top = (target as any).top;
    }

    const id = `ctx-${++this.counter}-${Date.now()}`;
    const item: ContextualFeedback = { id, message, left, top };
    this.contextualFeedback = item;
    this.notify();

    this.contextualTimer = setTimeout(() => {
      if (this.contextualFeedback?.id === id) {
        this.contextualFeedback = null;
        this.contextualTimer = null;
        this.notify();
      }
    }, CONTEXTUAL_FEEDBACK_DURATION_MS);

    return item;
  }

  public dismissContextualFeedback(): void {
    if (this.contextualTimer) {
      clearTimeout(this.contextualTimer);
      this.contextualTimer = null;
    }
    this.contextualFeedback = null;
    this.notify();
  }

  /**
   * Reseta completamente o gerenciador (útil para suíte de testes)
   */
  public reset(): void {
    if (this.activeGlobalTimer) {
      this.activeGlobalTimer.stop();
      this.activeGlobalTimer = null;
    }
    if (this.contextualTimer) {
      clearTimeout(this.contextualTimer);
      this.contextualTimer = null;
    }
    this.globalNotification = null;
    this.contextualFeedback = null;
    this.listeners.clear();
  }
}

export const notificationManager = new NotificationManager();
