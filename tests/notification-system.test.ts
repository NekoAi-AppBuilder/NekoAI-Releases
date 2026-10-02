import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  notificationManager,
  inferNotificationType,
  ToastTimerController,
  GLOBAL_TOAST_DURATION_MS,
  CONTEXTUAL_FEEDBACK_DURATION_MS
} from "../src/renderer/notification-system";

describe("NekoAI Notification System — Padronização de Notificações Globais & Feedback Contextual", () => {
  beforeEach(() => {
    notificationManager.reset();
  });

  // 1. success é renderizado / configurado
  it("1. Variante 'success' é configurada corretamente com ícone, título e tipo", () => {
    const toast = notificationManager.showGlobalNotification({
      type: "success",
      title: "Sucesso",
      message: "Commit salvo com sucesso!"
    });

    assert.strictEqual(toast.type, "success");
    assert.strictEqual(toast.title, "Sucesso");
    assert.strictEqual(toast.message, "Commit salvo com sucesso!");
    assert.strictEqual(notificationManager.getGlobalNotification()?.id, toast.id);
  });

  // 2. warning é renderizado / configurado
  it("2. Variante 'warning' é configurada corretamente com ícone, título e tipo", () => {
    const toast = notificationManager.showGlobalNotification({
      type: "warning",
      title: "Atenção",
      message: "Resolução pausada. Você pode continuar a qualquer momento pela barra superior."
    });

    assert.strictEqual(toast.type, "warning");
    assert.strictEqual(toast.title, "Atenção");
    assert.strictEqual(toast.message, "Resolução pausada. Você pode continuar a qualquer momento pela barra superior.");
  });

  // 3. error é renderizado / configurado
  it("3. Variante 'error' é configurada corretamente com ícone, título e tipo", () => {
    const toast = notificationManager.showGlobalNotification({
      type: "error",
      title: "Erro",
      message: "Erro ao sincronizar e combinar alterações."
    });

    assert.strictEqual(toast.type, "error");
    assert.strictEqual(toast.title, "Erro");
    assert.strictEqual(toast.message, "Erro ao sincronizar e combinar alterações.");
  });

  // 4. info é renderizado / configurado
  it("4. Variante 'info' é configurada corretamente com ícone, título e tipo", () => {
    const toast = notificationManager.showGlobalNotification({
      type: "info",
      title: "Informação",
      message: "Sincronização iniciada com o GitHub."
    });

    assert.strictEqual(toast.type, "info");
    assert.strictEqual(toast.title, "Informação");
    assert.strictEqual(toast.message, "Sincronização iniciada com o GitHub.");
  });

  // 5. duração padrão = 8 segundos
  it("5. Duração padrão é rigorosamente 8 segundos (8000ms) para todos os tipos", () => {
    const successToast = notificationManager.showGlobalNotification({
      type: "success",
      message: "Operação concluída com sucesso!"
    });
    assert.strictEqual(successToast.durationMs, 8000);
    assert.strictEqual(GLOBAL_TOAST_DURATION_MS, 8000);

    const warningToast = notificationManager.showGlobalNotification({
      type: "warning",
      message: "Atenção: alterações detectadas"
    });
    assert.strictEqual(warningToast.durationMs, 8000);

    const errorToast = notificationManager.showGlobalNotification({
      type: "error",
      message: "Erro ao conectar"
    });
    assert.strictEqual(errorToast.durationMs, 8000);

    const infoToast = notificationManager.showGlobalNotification({
      type: "info",
      message: "Informações gerais"
    });
    assert.strictEqual(infoToast.durationMs, 8000);
  });

  // 6. barra começa animando (inicia em 100%)
  it("6. Barra de progresso começa cheia (100% / progress = 1.0) ao iniciar", () => {
    let capturedProgress = -1;
    const controller = new ToastTimerController({
      durationMs: 8000,
      onTick: (progress) => {
        capturedProgress = progress;
      }
    });

    controller.start();
    assert.strictEqual(controller.isRunning(), true);
    assert.strictEqual(controller.isPaused(), false);
    assert.strictEqual(controller.getProgress(), 1.0);
    assert.strictEqual(capturedProgress, 1.0);
    assert.strictEqual(controller.getRemainingMs(), 8000);
    controller.stop();
  });

  // 7, 8, 9. hover pausa o timer e a animação da barra simultaneamente
  it("7, 8, 9. Hover pausa o timer e a animação da barra simultaneamente no ponto exato", () => {
    let tickCount = 0;
    const controller = new ToastTimerController({
      durationMs: 8000,
      onTick: () => {
        tickCount++;
      }
    });

    controller.start();
    // Simula 3 segundos decorridos
    controller.tick(3000);
    assert.strictEqual(controller.getRemainingMs(), 5000);
    assert.strictEqual(controller.getProgress(), 5000 / 8000); // 0.625

    // Hover acionado
    controller.pause();
    assert.strictEqual(controller.isPaused(), true);

    const remainingAtPause = controller.getRemainingMs();
    const progressAtPause = controller.getProgress();
    const ticksAtPause = tickCount;

    // Tempo passa enquanto em hover: nada deve avançar
    controller.tick(2000);
    assert.strictEqual(controller.getRemainingMs(), remainingAtPause);
    assert.strictEqual(controller.getProgress(), progressAtPause);
    assert.strictEqual(tickCount, ticksAtPause);
    controller.stop();
  });

  // 10, 11, 12, 13. mouseleave retoma timer e barra de onde pararam sem resetar os 8s
  it("10, 11, 12, 13. Mouseleave retoma timer e barra exatamente de onde pararam sem reiniciar 8s", () => {
    let dismissed = false;
    const controller = new ToastTimerController({
      durationMs: 8000,
      onDismiss: () => {
        dismissed = true;
      }
    });

    controller.start();
    controller.tick(3000); // 5000ms restantes
    assert.strictEqual(controller.getRemainingMs(), 5000);

    // Entra em hover
    controller.pause();
    assert.strictEqual(controller.isPaused(), true);
    assert.strictEqual(controller.getRemainingMs(), 5000);

    // Sai do hover
    controller.resume();
    assert.strictEqual(controller.isPaused(), false);

    // NÃO reiniciou para 8000ms; continua em 5000ms!
    assert.strictEqual(controller.getRemainingMs(), 5000);
    assert.strictEqual(controller.getProgress(), 5000 / 8000);

    // Completa os 5000ms restantes
    controller.tick(5000);
    assert.strictEqual(controller.getRemainingMs(), 0);
    assert.strictEqual(controller.getProgress(), 0);
    assert.strictEqual(dismissed, true);
  });

  // 14. X fecha imediatamente
  it("14. Botão X fecha a notificação imediatamente, cancelando o timer", () => {
    let dismissed = false;
    const controller = new ToastTimerController({
      durationMs: 8000,
      onDismiss: () => {
        dismissed = true;
      }
    });

    controller.start();
    controller.tick(1000);
    assert.strictEqual(controller.isRunning(), true);

    // Fechamento manual (stop)
    controller.stop();
    assert.strictEqual(controller.isRunning(), false);

    notificationManager.showGlobalNotification({
      type: "success",
      message: "Operação realizada"
    });
    assert.notStrictEqual(notificationManager.getGlobalNotification(), null);

    notificationManager.dismissGlobalNotification();
    assert.strictEqual(notificationManager.getGlobalNotification(), null);
  });

  // 15, 16, 17, 18. novo Toast substitui o anterior, cancelando timer anterior sem empilhamento
  it("15, 16, 17, 18. Novo Toast substitui o anterior, limpando timers e garantindo apenas 1 visível", () => {
    const toast1 = notificationManager.showGlobalNotification({
      type: "info",
      message: "Primeira notificação"
    });

    const timer1 = new ToastTimerController({ durationMs: toast1.durationMs });
    notificationManager.registerGlobalTimer(timer1);
    timer1.start();
    assert.strictEqual(timer1.isRunning(), true);

    // Dispara segunda notificação: substitui sem empilhar
    const toast2 = notificationManager.showGlobalNotification({
      type: "success",
      message: "Segunda notificação que substitui a primeira"
    });

    assert.notStrictEqual(toast1.id, toast2.id);
    assert.strictEqual(notificationManager.getGlobalNotification()?.id, toast2.id);
    // Timer anterior foi interrompido na substituição
    assert.strictEqual(timer1.isRunning(), false);
  });

  // 19. Toast desmontado não continua executando callbacks
  it("19. Toast parado/desmontado não continua executando callbacks", () => {
    let tickCount = 0;
    let dismissed = false;

    const controller = new ToastTimerController({
      durationMs: 8000,
      onTick: () => { tickCount++; },
      onDismiss: () => { dismissed = true; }
    });

    controller.start();
    controller.stop();
    const ticksAfterStop = tickCount;

    controller.tick(5000);
    assert.strictEqual(tickCount, ticksAfterStop);
    assert.strictEqual(dismissed, false);
  });

  // 20, 21. feedback contextual funciona separadamente e não interfere no Toast global
  it("20, 21. Feedback contextual funciona separadamente e não interfere no Toast global", () => {
    // 1. Dispara notificação global
    const globalToast = notificationManager.showGlobalNotification({
      type: "warning",
      message: "Atenção ao merge pendente"
    });
    assert.strictEqual(notificationManager.getGlobalNotification()?.id, globalToast.id);

    // 2. Dispara feedback contextual (ex: "Copiado!")
    const contextual = notificationManager.showContextualFeedback("Copiado!", { left: 250, top: 120 });

    assert.strictEqual(contextual.message, "Copiado!");
    assert.strictEqual(contextual.left, 250);
    assert.strictEqual(contextual.top, 120);

    // Toast global permanece intacto
    assert.strictEqual(notificationManager.getGlobalNotification()?.id, globalToast.id);
    assert.strictEqual(notificationManager.getContextualFeedback()?.message, "Copiado!");

    // Fechar contextual não afeta global
    notificationManager.dismissContextualFeedback();
    assert.strictEqual(notificationManager.getContextualFeedback(), null);
    assert.strictEqual(notificationManager.getGlobalNotification()?.id, globalToast.id);
  });

  // Demonstração exata do cenário solicitado pelo usuário no prompt:
  // 8s -> passar mouse após 3s -> restam aproximadamente 5s -> timer para -> barra para
  // -> retirar mouse -> timer continua com aproximadamente 5s -> barra continua -> encerra ao completar 8s
  it("CENÁRIO EXATO DO PROMPT: 8s -> hover após 3s (~5s restantes) -> pause -> resume (~5s restantes) -> encerra aos 8s", () => {
    let completed = false;
    let finalRemaining = -1;

    const controller = new ToastTimerController({
      durationMs: 8000,
      onDismiss: () => {
        completed = true;
        finalRemaining = controller.getRemainingMs();
      }
    });

    // 1. Toast apareceu com 8s completos
    controller.start();
    assert.strictEqual(controller.getRemainingMs(), 8000);
    assert.strictEqual(controller.getProgress(), 1.0);

    // 2. Passaram 3 segundos -> restam 5 segundos (barra em 62.5% ~ 62%)
    controller.tick(3000);
    assert.strictEqual(controller.getRemainingMs(), 5000);
    assert.strictEqual(Math.round(controller.getProgress() * 100), 63);

    // 3. Usuário coloca o mouse sobre o Toast -> TIMER PARA, BARRA PARA
    controller.pause();
    assert.strictEqual(controller.isPaused(), true);

    // 4. Permanece em hover por tempo arbitrário (ex: 4 segundos)
    controller.tick(4000);
    assert.strictEqual(controller.getRemainingMs(), 5000); // Exatos 5s preservados!
    assert.strictEqual(Math.round(controller.getProgress() * 100), 63); // Barra parada na mesma posição!
    assert.strictEqual(completed, false);

    // 5. Usuário retira o mouse -> TIMER CONTINUA com os 5s restantes
    controller.resume();
    assert.strictEqual(controller.isPaused(), false);
    assert.strictEqual(controller.getRemainingMs(), 5000); // NÃO reiniciou para 8s!
    assert.strictEqual(Math.round(controller.getProgress() * 100), 63);

    // 6. Mais 2 segundos passam -> restam 3 segundos
    controller.tick(2000);
    assert.strictEqual(controller.getRemainingMs(), 3000);
    assert.strictEqual(Math.round(controller.getProgress() * 100), 38);
    assert.strictEqual(completed, false);

    // 7. Passam os últimos 3 segundos -> encerra exatamente ao completar os 8s efetivos
    controller.tick(3000);
    assert.strictEqual(controller.getRemainingMs(), 0);
    assert.strictEqual(controller.getProgress(), 0);
    assert.strictEqual(completed, true);
    assert.strictEqual(finalRemaining, 0);
  });

  // Inferência automática para chamadas legadas
  it("Inferência automática de tipo e título para chamadas de showToast legadas", () => {
    assert.deepStrictEqual(inferNotificationType("Commit salvo com sucesso!"), { type: "success", title: "Sucesso" });
    assert.deepStrictEqual(inferNotificationType("Alterações enviadas para o GitHub."), { type: "success", title: "Sucesso" });
    assert.deepStrictEqual(inferNotificationType("Resolução pausada."), { type: "warning", title: "Atenção" });
    assert.deepStrictEqual(inferNotificationType("Sincronização pendente."), { type: "warning", title: "Atenção" });
    assert.deepStrictEqual(inferNotificationType("Erro ao abrir projeto"), { type: "error", title: "Erro" });
    assert.deepStrictEqual(inferNotificationType("Falha ao sincronizar"), { type: "error", title: "Erro" });
    assert.deepStrictEqual(inferNotificationType("Esta pasta não existe mais no computador."), { type: "error", title: "Erro" });
    assert.deepStrictEqual(inferNotificationType("Sincronização iniciada."), { type: "info", title: "Informação" });
  });

  // Validação da Camada Global e Hierarquia de Z-Index
  it("Camada Global: --z-notification-layer está centralizada no :root e sobrepõe modais, previews e titlebar", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const stylesPath = path.resolve(__dirname, "../src/renderer/styles.css");
    const stylesContent = fs.readFileSync(stylesPath, "utf-8");

    // 1. Constante centralizada no :root
    assert.match(stylesContent, /--z-notification-layer:\s*999999;/, "Deve definir --z-notification-layer: 999999 na escala centralizada");

    // 2. Camada dedicada .neko-global-toast-layer
    assert.match(stylesContent, /\.neko-global-toast-layer\s*\{[^}]*position:\s*fixed/s, "Camada deve ter position: fixed");
    assert.match(stylesContent, /\.neko-global-toast-layer\s*\{[^}]*z-index:\s*var\(--z-notification-layer/s, "Camada deve usar --z-notification-layer");
    assert.match(stylesContent, /\.neko-global-toast-layer\s*\{[^}]*pointer-events:\s*none/s, "Camada deve ter pointer-events: none para não bloquear áreas transparentes");
    assert.match(stylesContent, /\.neko-global-toast\s*\{[^}]*pointer-events:\s*auto/s, "Card do Toast deve ter pointer-events: auto para cliques e hover");

    // 3. Posicionamento no canto superior direito abaixo da barra de ferramentas (96px)
    assert.match(stylesContent, /\.neko-global-toast-layer\s*\{[^}]*top:\s*96px/s, "Camada deve iniciar em top: 96px (abaixo da barra de ferramentas)");
    assert.match(stylesContent, /\.neko-global-toast-layer\s*\{[^}]*right:\s*20px/s, "Camada deve estar alinhada à direita (right: 20px)");
  });

  it("Camada Global: GlobalNotificationToast utiliza createPortal para document.body e isola-se de stacking contexts", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const componentPath = path.resolve(__dirname, "../src/renderer/components/GlobalNotificationToast.tsx");
    const componentContent = fs.readFileSync(componentPath, "utf-8");

    // 1. Importação e uso de createPortal
    assert.match(componentContent, /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/, "Componente deve importar createPortal de react-dom");
    assert.match(componentContent, /createPortal\(\s*<div\s*className="neko-global-toast-layer"/, "Componente deve criar portal com a camada .neko-global-toast-layer");
    assert.match(componentContent, /document\.body/, "Portal deve ser anexado diretamente ao document.body");

    // 2. Suporte à desativação de portal (usePortal = false) para ambientes sem DOM
    assert.match(componentContent, /usePortal\s*\?:\s*boolean/, "Prop usePortal deve ser suportada para flexibilidade");
  });

  // Validação estrita do mapeamento de títulos visíveis em Português mantendo identificadores internos
  it("Mapeamento de Títulos em Português: Sucesso, Atenção, Erro, Informação preservando identificadores internos em inglês", () => {
    const s = notificationManager.showGlobalNotification({ type: "success", message: "Mensagem" });
    assert.strictEqual(s.type, "success");
    assert.strictEqual(s.title, "Sucesso");

    const w = notificationManager.showGlobalNotification({ type: "warning", message: "Mensagem" });
    assert.strictEqual(w.type, "warning");
    assert.strictEqual(w.title, "Atenção");

    const e = notificationManager.showGlobalNotification({ type: "error", message: "Mensagem" });
    assert.strictEqual(e.type, "error");
    assert.strictEqual(e.title, "Erro");

    const i = notificationManager.showGlobalNotification({ type: "info", message: "Mensagem" });
    assert.strictEqual(i.type, "info");
    assert.strictEqual(i.title, "Informação");
  });
});
