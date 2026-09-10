# NekoAI v0.4.65 — Terminal Interno

## Objetivo
Fazer Logs, Console e Erros do Preview/Agent aparecerem dentro do workspace da NekoAI.

## Implementado
- stdout/stderr do Preview → terminal;
- stdout/stderr do OpenCode → Logs;
- Build → terminal;
- console-message do Preview → Console/Erros;
- classificação de stderr claramente relacionado a erro;
- limite de 800 linhas no renderer;
- correção da assinatura Electron `console-message`;
- manutenção do terminal no fundo escuro do workspace.

## Validação
O build completo depende das dependências instaladas no ambiente do usuário. A validação funcional deve ser feita com projeto Vite real, console.log/warn/error e erro de build/runtime.
