# NekoAI v0.4.53 — Electron Cache Fix + Agent Live Execution

## Objetivo
Melhorar a observabilidade e a UX do fluxo Plan → Aprovar → Build sem alterar GitHub, providers, Model Picker ou o Preview Manager.

## Alterações
- Watcher nativo do diretório do projeto para atualizar a árvore de arquivos enquanto o agente cria/edita arquivos.
- Eventos de arquivo atualizam a árvore e o arquivo aberto.
- Status do agente passa a refletir ferramenta/arquivo/comando real, evitando o falso “Tentando novamente...” durante uma execução normal.
- Retry recebe status contextual quando o OpenCode fornece motivo.
- Logs do terminal passam a registrar de forma resumida ferramentas, arquivos, permissões, sessão e comandos, sem despejar payloads completos.
- Low/Medium/High passa a ser persistido em preferência local do usuário.
- Quando o modelo oferece variantes com esses nomes, a variante correspondente é enviada ao OpenCode; quando não oferece, a preferência continua salva sem forçar uma variante inválida.
- Durante uma execução, composer, modelo, esforço, Plan e anexos ficam bloqueados; Stop permanece ativo.
- Modais principais passam para largura máxima de aproximadamente 600px.

## Limitação de validação
O ambiente de trabalho não possui `node_modules`. `npm install` excedeu o tempo disponível e o `tsc` global não conseguiu compilar porque os tipos `electron` e `node` não estão instalados localmente. A fonte foi revisada e o pacote foi preparado, mas o build completo deve ser validado na máquina de desenvolvimento com `npm install` e `npm run build`.
