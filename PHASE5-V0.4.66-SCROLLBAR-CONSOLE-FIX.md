# Fase 5 — v0.4.66

## Scrollbar global + console-message

### Objetivo
Corrigir a regressão das scrollbars estilizadas da NekoAI e o erro de compilação no listener `console-message`.

### Implementado
- Compatibilidade com assinatura antiga e nova do Electron para `console-message`.
- Tipagem segura sem depender da versão específica de `@types/electron`.
- Scrollbar global para todos os elementos com overflow.
- Visual compacto, escuro e roxo consistente com a NekoAI.

### Não alterar
- Comportamento do Agent.
- OpenCode.
- Model Picker.
- GitHub.
- Sistema de Preview.
- Dimensões de modais (500px).

### Validação
A build precisa passar `vite build` e `tsc -p tsconfig.main.json`; depois validar runtime e Console do Preview.
