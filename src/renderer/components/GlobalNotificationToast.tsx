import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  GlobalNotification,
  ToastTimerController,
  notificationManager
} from "../notification-system";

export interface GlobalNotificationToastProps {
  notification: GlobalNotification;
  onDismiss: (id: string) => void;
  usePortal?: boolean;
}

/**
 * Ícones Padronizados Conforme Referência Visual (media_1790921639514.jpg)
 * Círculo de 32px com traço de 2.2px e glifo centralizado correspondente
 */
export const ToastIcon: React.FC<{ type: GlobalNotification["type"] }> = ({ type }) => {
  switch (type) {
    case "success":
      return (
        <svg
          className="neko-toast-svg neko-toast-svg-success"
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.2" />
          <polyline
            points="10 16.5 14 20.5 22 12.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "warning":
      return (
        <svg
          className="neko-toast-svg neko-toast-svg-warning"
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.2" />
          <line
            x1="16"
            y1="9.5"
            x2="16"
            y2="17.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="16" cy="22" r="1.35" fill="currentColor" />
        </svg>
      );

    case "error":
      return (
        <svg
          className="neko-toast-svg neko-toast-svg-error"
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.2" />
          <line
            x1="11.5"
            y1="11.5"
            x2="20.5"
            y2="20.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <line
            x1="20.5"
            y1="11.5"
            x2="11.5"
            y2="20.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      );

    case "info":
    default:
      return (
        <svg
          className="neko-toast-svg neko-toast-svg-info"
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="16" cy="10" r="1.35" fill="currentColor" />
          <line
            x1="16"
            y1="14"
            x2="16"
            y2="22"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <line
            x1="13.5"
            y1="14"
            x2="16"
            y2="14"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <line
            x1="13.5"
            y1="22"
            x2="18.5"
            y2="22"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
};

/**
 * Componente Padronizado de Notificação Global
 */
export const GlobalNotificationToast: React.FC<GlobalNotificationToastProps> = ({
  notification,
  onDismiss,
  usePortal = true,
}) => {
  const progressBarRef = React.useRef<HTMLDivElement | null>(null);
  const controllerRef = React.useRef<ToastTimerController | null>(null);

  React.useEffect(() => {
    // Instancia o controlador sincronizado de 8 segundos
    const controller = new ToastTimerController({
      durationMs: notification.durationMs,
      onTick: (progress: number) => {
        if (progressBarRef.current) {
          // Atualização direta por hardware via transform scaleX (sem re-renders)
          progressBarRef.current.style.transform = `scaleX(${progress})`;
        }
      },
      onDismiss: () => {
        onDismiss(notification.id);
      },
    });

    controllerRef.current = controller;
    notificationManager.registerGlobalTimer(controller);
    controller.start();

    return () => {
      controller.stop();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [notification.id, notification.durationMs, onDismiss]);

  const handleMouseEnter = React.useCallback(() => {
    // Regra 5 & 6: Pausa estrita simultânea do timer e da barra no ponto atual
    controllerRef.current?.pause();
  }, []);

  const handleMouseLeave = React.useCallback(() => {
    // Regra 5 & 6: Retomada exata do ponto onde parou sem resetar os 8 segundos
    controllerRef.current?.resume();
  }, []);

  const handleManualClose = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Regra 7: Fechamento manual imediato via botão X
      controllerRef.current?.stop();
      onDismiss(notification.id);
    },
    [notification.id, onDismiss]
  );

  const toastCard = (
    <div
      className={`neko-global-toast neko-global-toast-${notification.type}`}
      data-type={notification.type}
      role="alert"
      aria-live="assertive"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="neko-global-toast-body">
        <div className="neko-global-toast-icon-wrapper">
          <ToastIcon type={notification.type} />
        </div>

        <div className="neko-global-toast-text-wrapper">
          <div className="neko-global-toast-title">{notification.title}</div>
          <div className="neko-global-toast-message">{notification.message}</div>
        </div>

        <button
          type="button"
          className="neko-global-toast-close"
          onClick={handleManualClose}
          aria-label="Fechar notificação"
          title="Fechar"
        >
          <X size={12} strokeWidth={2.4} />
        </button>
      </div>

      {/* Barra de Progresso no Rodapé */}
      <div className="neko-global-toast-progress-track">
        <div
          ref={progressBarRef}
          className="neko-global-toast-progress-bar"
          style={{ transform: "scaleX(1)" }}
        />
      </div>
    </div>
  );

  // Portal direto no document.body para garantir isolamento absoluto contra stacking contexts
  if (usePortal !== false && typeof document !== "undefined" && document.body) {
    return createPortal(
      <div className="neko-global-toast-layer" aria-live="polite" aria-atomic="true">
        {toastCard}
      </div>,
      document.body
    );
  }

  return toastCard;
};
