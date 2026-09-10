# NekoAI v0.4.64 — Fase 5: execução contínua e validação

Esta versão amplia a Fase 5 com quatro mecanismos principais:

1. **Retry automático do Agent**
   - preserva a tarefa original;
   - recupera falhas temporárias;
   - usa backoff progressivo;
   - não converte uma falha transitória em conclusão.

2. **Terminal interno**
   - Logs;
   - Console;
   - Erros;
   - saída do Preview e do build dentro do workspace.

3. **Validação automática**
   - inicia/revalida o Preview;
   - executa `scripts.build` quando disponível;
   - captura erros reais;
   - mantém warnings separados de erros fatais.

4. **Auto-reparo**
   - quando build ou Preview falham após uma tarefa do Agent, o Neko devolve o diagnóstico técnico ao mesmo contexto;
   - o Agent recebe instrução explícita para corrigir e testar novamente;
   - máximo técnico de 3 ciclos de reparo por tarefa para evitar loop infinito.

## Importante

A Fase 5 permanece **em validação** até que `npm run build` e os testes de execução real sejam feitos na máquina de desenvolvimento.
