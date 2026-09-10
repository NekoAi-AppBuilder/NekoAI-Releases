# NekoAI v0.4.70 — Performance + Preview Core

## Objetivo

Implementar a prioridade máxima definida para estabilizar o Preview e reduzir trabalho redundante durante a execução do Agent.

## Implementado

- Deduplicação de transições de `session.status` antes do Renderer.
- `session.updated` e `session.diff` permanecem no processo principal e não chegam ao Renderer.
- SSE continua como fonte principal do estado da execução.
- Polling de recuperação só é acionado quando o fluxo de eventos fica silencioso por tempo suficiente.
- Preview interno permanece oculto até o tema visual ser aplicado.
- Tema de scrollbar preparado em document-start para páginas locais do Preview.
- Reaplicação do tema após carregamento do frame e por IPC sob demanda.
- Preview externo permanece oculto durante o carregamento e só é mostrado após o tema estar aplicado.
- Terminal/diagnóstico possui altura fixa e scroll interno.
- Auto-scroll do terminal só ocorre quando o usuário já está próximo do fim.
- Deduplicação de linhas idênticas consecutivas no terminal.

## Não implementado nesta etapa

A segunda prioridade fica deliberadamente para depois da validação desta versão:

- otimização da estratégia de build/validação;
- esforço adaptativo Low/Medium/High;
- pipeline/cache de anexos e imagens.

As métricas internas de latência também ficam para a etapa seguinte, conforme solicitado.

## Validação obrigatória

- [ ] `npm install`
- [ ] `npm run build`
- [ ] Preview interno sem flash da scrollbar padrão.
- [ ] Preview externo sem flash da scrollbar padrão.
- [ ] Terminal com altura fixa e scroll interno.
- [ ] Repetições de `busy` não geram atividade visual repetitiva.
- [ ] Execução continua responsiva durante ferramentas/streaming.
- [ ] Múltiplos projetos continuam isolados.
