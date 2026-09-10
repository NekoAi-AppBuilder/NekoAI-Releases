# NekoAI v0.4.58 — Chat Undo, Edit & Task Timing

## Implementado

- Ações nas respostas do agente: Undo, Copiar e duração da tarefa.
- Duração exibida no formato `Xs` ou `Xm Ys`.
- Mensagens do usuário mostram Copiar/Editar somente ao passar o mouse ou focar.
- Editar uma mensagem restaura o checkpoint da execução anterior, substitui a solicitação e executa novamente.
- Undo restaura o estado dos arquivos de código anterior à tarefa e reinicia o Preview.
- Checkpoints ficam em memória para não persistir cópias de `.env` ou outros segredos em disco.
- `node_modules`, `.git`, `dist`, caches e diretórios de runtime não fazem parte do checkpoint.
- Checkpoint limitado a 5.000 arquivos e 250 MB por tarefa para evitar consumo descontrolado de memória.
- Modais permanecem limitados a 500 px conforme a definição anterior da interface.

## Validação esperada

1. `npm run build` deve concluir Vite + TypeScript sem erros.
2. Abrir um projeto, enviar uma tarefa e confirmar que a resposta final mostra Undo, Copiar e duração.
3. Clicar em Undo e confirmar restauração dos arquivos e reinicialização do Preview.
4. Passar o mouse em uma mensagem do usuário e confirmar Copiar/Editar.
5. Editar a mensagem e reenviar; confirmar que a execução anterior é restaurada antes da nova execução.
6. Testar em dois projetos diferentes na mesma instância e confirmar checkpoints independentes por projeto.
