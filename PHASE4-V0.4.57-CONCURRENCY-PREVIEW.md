# NekoAI v0.4.57 — Agent Concurrency + Preview Fix

## Objetivo
Corrigir a execução com múltiplas instâncias da Neko e evitar que eventos de sessão disparem reinicializações repetidas do Preview.

## Alterações
- Preview agora é deduplicado por workspace enquanto uma inicialização está em andamento.
- `syncSessionOutput` não reinicia mais o Preview a cada sincronização de mensagem.
- O Preview é reiniciado somente quando o projeto muda ou quando o usuário solicita explicitamente.
- Resolução da raiz do Preview procura `package.json` até 3 níveis abaixo do workspace e prioriza o pacote com `scripts.dev`.
- Watcher ignora `node_modules`, `dist`, `.vite`, caches, logs, temporários e artefatos de build.
- Estado do Preview mantém processo/porta associados à instância atual.
- Modais limitados a 500px.
- Mantidos os diagnósticos detalhados de erros de agente da v0.4.55.

## Observação
Cada instância do Electron possui seu próprio processo e estado de Preview. O Preview não deve reutilizar um servidor de outro projeto apenas porque uma porta padrão está ocupada; ele inicia um servidor próprio em uma porta livre para o projeto atual.
