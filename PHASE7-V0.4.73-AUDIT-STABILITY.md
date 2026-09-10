# NekoAI v0.4.73 — Fase 7: Auditoria Geral & Estabilidade

## Itens implementados e consolidados nesta versão:

1. **Ciclo de Vida de Processos Filhos (Zero Zumbis)**:
   - `stopOpenCode()` e `stopPreview()` unificados com encerramento assíncrono garantido via `taskkill.exe /PID ... /T /F` no Windows, aguardando término antes de prosseguir.
   - Handlers globais de saída registrados no Electron e Node (`before-quit`, `will-quit`, `SIGINT`, `SIGTERM`, `process.on("exit")`), executando terminação síncrona de emergência de qualquer processo filho restante.

2. **Gerenciamento Seguro de Portas e Watchers**:
   - `findFreePort`: garantia de liberação imediata e ausência de sockets em `TIME_WAIT`.
   - `startProjectWatcher`: tratamento de erro explícito com captura de evento `error` e reinício limpo sem memory leak caso pastas sejam renomeadas ou excluídas.

3. **Isolamento Estrito entre Múltiplos Projetos**:
   - Limpeza profunda ao alternar projetos: reset imediato de terminais, arquivos abertos, planos de execução pendentes e aprovados, timers de retentativa, assinaturas de erro do Preview e histórico de tarefas do Agent.

4. **Contenção de Memória e Profiling**:
   - `attemptedErrorSignatures` com política de expiração automática (>10min) e teto de retenção (50 itens).
   - Profiling e diagnóstico de latência com monotonic clock (`hrtime.bigint()`), imune a oscilações do relógio do SO.

5. **Segurança e Privacidade**:
   - Sanitização de credenciais, tokens, API keys e variáveis confidenciais mantida em todas as camadas de diagnósticos, console do Preview e pontes IPC.

---

## Validação:
- [x] `npm run build` executado e aprovado com sucesso.
- [x] Desalocação segura de processos filhos testada.
- [x] Isolamento de múltiplos projetos validado no Renderer e Main Process.
