# NekoAI v0.4.60 — Agent Performance / Event Noise

## Objetivo
Reduzir trabalho desnecessário da Neko durante execuções longas e tornar a latência observável sem alterar o motor OpenCode.

## Alterações
- Redução do polling de saúde do OpenCode de 1,2s para 2,5s.
- Redução do polling de permissões de 0,9s para 1,8s.
- Watchdog de `session.status` de 1,8s para 3,5s; SSE continua sendo a fonte principal.
- Terminal deixa de imprimir todos os `session.updated`, `session.diff` e `busy/idle`; eventos repetitivos são amostrados a cada 2,5s.
- Eventos de ferramentas, arquivos, permissões e erros continuam sendo registrados.
- Log explícito mede o tempo para o OpenCode aceitar o `prompt_async`. Isso separa latência da Neko/IPC da latência do provedor/modelo.
- UI inicia com `Enviando para o modelo...` e muda para a atividade real assim que o OpenCode emitir ferramenta/arquivo.

## Diagnóstico
`session.status=busy` imediatamente após `prompt_async` é esperado: significa que o OpenCode aceitou a execução e está processando. Ele não é, sozinho, indicação de lentidão. A nova instrumentação permite distinguir:

1. Neko demorando para entregar a tarefa;
2. OpenCode aguardando o modelo;
3. modelo/provedor demorando para responder;
4. ferramenta/comando demorando;
5. instalação/build/validação demorando.

## Não alterado
- Não foi colocado timeout curto para a execução.
- Não foi alterado o comportamento do agente para interromper tarefas longas.
- Não foi substituído o `prompt_async`; ele continua permitindo que a execução seja acompanhada pelo SSE.
