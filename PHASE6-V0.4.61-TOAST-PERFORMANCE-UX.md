# NekoAI v0.4.61 — Toast contextual + chat action UX

## Alterações
- Toasts de ações agora aparecem próximos ao elemento que disparou a ação.
- Copiar resposta do agente usa a posição do botão clicado.
- Copiar mensagem do usuário usa a posição do botão clicado.
- Copiar código de autorização do GitHub usa a posição do botão clicado.
- Desfazer tarefa usa a posição do botão clicado.
- Removido o toast global fixo no topo/centro.
- Mantidos os controles do chat sem criar um novo fundo visual: undo, copiar e duração continuam integrados ao fundo escuro da mensagem.
- Versão incrementada para 0.4.61.

## Performance
A instrumentação de 0.4.60 continua: polling reduzido, eventos repetitivos amostrados e `prompt_async` assíncrono.

O `busy` repetido no terminal é estado do OpenCode e não deve ser tratado como várias execuções. Eventos de ferramenta/arquivo são os indicadores de trabalho real.

## Build
O build precisa ser validado no ambiente Windows com `npm install` e `npm run build`, pois o ambiente de empacotamento desta alteração não possui o sprite/dependências do `@opencode-ai/ui` instalados.
