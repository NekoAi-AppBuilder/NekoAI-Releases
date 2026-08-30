# NekoAI v0.4.64

## Fase 5 — execução contínua, Preview e validação

- Retry automático de falhas temporárias do Agent com backoff.
- Terminal integrado com Logs, Console e Erros.
- Captura de saída do Preview e do build.
- Validação automática do build e Preview ao finalizar uma tarefa.
- Auto-reparo quando a validação encontra erro, mantendo o mesmo contexto.
- Warnings de console não são tratados como falhas fatais.
- Roadmap oficial incluído em `NekoAI-ROADMAP.md` e deve ser lido antes de novas implementações.

## Execução

```powershell
npm install
npm run build
npm start
```

# NekoAI v0.4.24

## v0.4.24 — Plan handoff + staged approvals
- O plano aprovado não é mais despejado inteiro como mensagem no chat.
- O usuário vê um resumo e pode expandir para consultar o plano completo.
- Após aprovação, permanece um cartão compacto do plano com opção de expandir.
- Aprovações do OpenCode continuam sendo respondidas pelo mecanismo nativo, com uma etapa por vez.
- Adicionado polling de fallback para não perder solicitações de permissão quando um evento SSE atrasar ou for perdido.
- Mantidos os estados Permitir uma vez, Permitir sempre e Rejeitar.


## v0.4.20 — Plan Mode Fix
- Corrigido o modo Plan para usar o endpoint síncrono `/session/:id/message`, garantindo que o resultado do plano seja devolvido ao renderer e que o estado `busy` seja encerrado mesmo quando o stream SSE não emitir `session.status: idle` a tempo.
- O modo Plan usa o agente nativo `plan` do OpenCode sem sobrescrever seu system prompt, preservando as permissões e o comportamento oficial de planejamento.
- Adicionado timeout de 180 segundos para evitar execução indefinida no modo Plan.
- O modo Build continua usando `/prompt_async` e mantém o fluxo assíncrono existente.

# NekoAI v0.3.3

NekoAI Studio desktop app.

## Run

```powershell
npm install
npm run build
npm start
```

OpenCode is bundled at `tools/opencode.exe`; no `.env` or `NEKO_OPENCODE_PATH` is required.

This version also includes: native model/provider UI, isolated chat scrolling, Preview/Code workspace, bundled OpenCode startup, and a production CSP.


## v0.3.3.3
- Corrigida a tipagem do nível do evento `console-message` do Electron: o `level` é numérico nesta assinatura, então o filtro usa `level >= 2`.


## v0.3.4
- Scrollbars finas e discretas em todo o Studio, com comportamento suave/contained.
- Seletor e gerenciamento mostram somente modelos ativos/conectados.
- Prompt enviado via `/prompt_async` para não bloquear o Neko esperando o agente terminar.
- Agente usa `build` e recebe instrução para deixar servidores dev de longa duração para o Preview Manager.
- Ao `session.idle`, o Neko atualiza mensagens, arquivos e preview automaticamente.


## v0.3.5 - Live Activity
- Painel de atividade ao vivo no chat usando eventos do OpenCode.
- Mostra ferramentas, arquivos alterados, comandos, permissões e término da sessão.
- Scrolls refinados para aparência compacta e suave.


## v0.3.6
- O chat rola automaticamente para a atividade/mensagem mais recente.
- O scroll do chat usa `scrollTo({ behavior: "smooth" })`.
- O aplicativo abre em fullscreen na primeira exibição da janela.


## v0.3.7
- Corrigido o toggle de modelos: ativo/inativo agora funciona e persiste.
- O seletor principal mostra somente modelos conectados e ativos.
- O Gerenciar modelos mostra os modelos conectados, inclusive os desativados, para permitir reativação.
- Preferências ficam em `model-settings.json` dentro do diretório de dados do Electron.
- Pesquisa compacta e unificada entre seletor e gerenciamento.


## v0.3.8 — Attachments + Composer helpers
- Botão `+` abre seletor real de arquivos compatíveis.
- Ctrl+V em imagem adiciona a imagem ao prompt.
- Drag & drop de arquivos abre o mesmo fluxo de anexos.
- Chips removíveis de anexos no composer.
- Anexos enviados ao OpenCode como partes `file` com URI local.
- Limite de 20 MiB total no picker, alinhado ao limite documentado pelo OpenCode.
- ` / ` exibe autocomplete de comandos do OpenCode e executa comandos via endpoint `command`.
- ` @ ` exibe autocomplete de arquivos do projeto e inclui os arquivos selecionados no contexto.
- O OpenCode atualmente torna texto UTF-8 e PNG/JPEG/GIF/WebP visíveis ao modelo; outros binários como PDF não entram no contexto do modelo sem uma etapa de conversão.


## v0.3.8.1
- A janela inicia maximizada, mantendo barra de título e barra de tarefas do Windows.
- Removido `setFullScreen(true)`.


## v0.3.8.2
- Corrigido o regex do envio de comandos `/` no `main.ts`.


v0.3.9: chat collapse; attachment cards/previews; 10 files / 50 MB total with 20 MB per-file OpenCode compatibility; failed upload cards.


## v0.3.9.1
- Corrigida a busca de arquivos para pesquisar recursivamente em pastas e preservar o caminho dos diretórios correspondentes.
- Campo de busca agora usa texto destacado, spellcheck/autocorrect desativados e placeholder discreto.
- Exibe mensagem quando nenhum arquivo é encontrado.


## v0.3.9.2
- Corrigida a função `searchProjectFiles` que estava sendo chamada pelo IPC sem existir.
- Busca recursiva de arquivos mantém diretórios relevantes e limita resultados a 200.


## v0.3.9.4
- Collapse movido para antes de Preview/Código.
- Botão Enviar vira Parar durante a execução; usa `POST /session/:id/abort`.
- Preview mobile/tablet agora usa dimensões de viewport próprias e área rolável do preview.
- Texto de permissão ficou mais claro.


## v0.3.9.6
- Confirmações de permissão do OpenCode aparecem no chat com Permitir uma vez, Permitir sempre e Negar.
- Atividade ordenada cronologicamente e conclusão retardada para não aparecer antes de alterações finais.
- CSP permite frames HTTPS para checkouts externos.
- Preview Manager evita shell:true no Windows.


## v0.3.9.7
- Corrigida a execução de `npm.cmd`/pnpm/yarn/bun no Windows via `cmd.exe /c`, sem aspas no executável.
- Evita o erro `'npm.cmd' não é reconhecido` causado pela linha de comando anterior.


## v0.3.9.7.1
- Corrigido `TS1127/TS1434` causado por uma sequência literal `\n` inserida no código do Preview Manager.


## v0.3.9.7.2
- Corrigido o fechamento da expressão template literal do log do Preview Manager que causava uma cascata de 81 erros TS1005/TS1128.

## v0.4.0 — GitHub Connect
- GitHub App Device Flow usando o Client ID configurado pelo usuário.
- Conectar/autorizar GitHub pelo navegador.
- Persistência do token com Electron `safeStorage`.
- Refresh automático do token quando aplicável.
- Mostrar usuário conectado e listar repositórios.
- Abrir repositório no navegador e desconectar.


## v0.4.0 — JSX Fix 2
- Corrigido o fechamento do backdrop e do conteúdo do modal GitHub em `src/renderer/main.tsx`.


## GitHub JSX Fix 2
- Corrigido o fechamento do fragmento JSX do modal GitHub.


## GitHub JSX Fix 3
- Corrigida a estrutura JSX dos modais: cada condição fecha apenas seu fragmento; o backdrop e o modal fecham uma única vez no final.


## GitHub JSX Fix 4
- Removido o import inválido `Github` do lucide-react e substituído por um SVG inline compatível.


## v0.4.1 — GitHub Private + Avatar
- Corrigida a listagem para usar instalações do GitHub App e o endpoint `/user/installations/{installation_id}/repositories`, permitindo repositórios privados concedidos à instalação.
- Adicionada orientação/botão para instalar/configurar o GitHub App quando ainda não houver instalação.
- Liberado `avatars.githubusercontent.com` na CSP para a foto de perfil do GitHub.


## v0.4.2 — GitHub Project Linking
- Adicionado status Git do projeto local.
- Adicionado vínculo do projeto local ao `origin` de um repositório GitHub selecionado.
- Proteção para substituir um `origin` diferente apenas com confirmação explícita.
- Incluídos estado de branch, remote e arquivos modificados no fluxo de vínculo.
- Nenhum push/commit é executado nesta etapa.


## v0.4.2 — GitHub Link Runtime Fix
- Corrigidas as funções `openGithubLink` e `linkGithubProject` que estavam sendo referenciadas pelo JSX, mas não tinham sido inseridas no renderer.


## v0.4.3 — GitHub Link UX
- O modal agora identifica claramente quando o projeto já está vinculado.
- O botão passa a ser `Fechar` quando já vinculado.
- Ao concluir um vínculo novo, o modal fecha automaticamente após atualizar o status.
- O processo de vínculo mostra estado visual de progresso.


## v0.4.4 — Repo + Branch Context
- O cabeçalho existente do projeto agora mostra o nome local, o repositório vinculado logo abaixo e o branch ao lado.
- Branches disponíveis são carregadas do GitHub.
- Ao trocar de branch, o Neko atualiza a branch local; se a branch só existir remotamente, ela é criada localmente a partir de `origin/<branch>`.
- Troca é bloqueada quando existem alterações locais não commitadas.
- Quando a API não retorna branches, o seletor mantém fallback para a branch atual ou `main/master`.


## v0.4.5 — Studio Header
- Reestruturado o cabeçalho com seletor de projeto central, nome do projeto e repositório na mesma unidade visual.
- Adicionados atalhos Novo Projeto e Clonar Site.
- Adicionados indicadores compactos de Vercel e GitHub com status.
- Branch permanece acessível no topo e no seletor de projeto, mantendo a identidade roxa do NekoAI.


## v0.4.6 — Reference Header Match
- Cabeçalho refinado para reproduzir diretamente a composição visual enviada: seletor de projeto central, Novo Projeto, Clonar Site, indicadores Vercel/GitHub, branch e status do Neko.
- Mantida a identidade NekoAI e os recursos existentes de GitHub/branch.


## v0.4.7 — Empty Project Selector
- Alterado somente o estado sem projeto: `Novo projeto` e `Escolha uma pasta para começar` ficam centralizados dentro da mesma caixa, sem ícone lateral.


## v0.4.8 — Complete Header / Empty State Refinement
- Aplicadas todas as alterações visuais especificadas para o cabeçalho: seletor de projeto central, ações Novo Projeto e Clonar Site, indicadores Vercel/GitHub, branch e status do Neko.
- Estado sem projeto mantém `Novo projeto` e `Escolha uma pasta para começar` centralizados dentro da própria caixa, sem ícone lateral.
- O estado vazio do painel do Neko também recebeu o CTA verde de Novo Projeto conforme a referência.
- Vercel não é mais marcado como conectado com base no preview local; permanece alerta até uma integração real ser configurada.
- Branches do menu superior são deduplicadas antes de serem renderizadas.
- Mantidos os ícones como componentes SVG/Lucide, sem caracteres Alt Code.


## v0.4.9 — Header Alignment + Recent Projects + Real Logo
- O header passa a usar a mesma origem horizontal do workspace/collapse (360px no estado normal e 0px quando o chat está recolhido).
- O seletor do topo agora é baseado em Projetos Recentes persistidos localmente, com até 10 entradas.
- Quando não há projeto atual e não existem projetos recentes, o seletor do topo não é exibido; permanecem Novo Projeto e Clonar Site.
- Quando existem projetos recentes, o seletor abre a lista e permite reabrir diretamente uma pasta sem abrir o diálogo de seleção.
- O logo oficial fornecido foi incorporado como asset real.
- A toolbar mantém a ordem collapse → Preview → Código → framework → controles.
- Branches continuam deduplicadas antes da renderização.


## v0.4.9 — JSX/TS source escape fix
- Corrigidas as sequências literais `\\n` que haviam sido inseridas no `main.tsx`, causando `Invalid Unicode escape sequence` no Vite.


## v0.4.9 — String literal fix 2
- Corrigido o `join` do conteúdo das mensagens que havia ficado com uma quebra de linha literal dentro da string.


## v0.4.9 — Recent Projects Runtime Fix
- Corrigido `ChevronUp` ausente no renderer.
- Seletor de branches passa a usar branches locais e remotas (`origin/*`) do projeto vinculado, evitando depender do endpoint `/repos/{owner}/{repo}/branches` do GitHub App, que retornou HTTP 403.
- Tentativa de `git fetch origin` só ocorre como fallback quando não há branches locais/remotas disponíveis e não bloqueia a interface em caso de falha.


## v0.4.10 — Startup Stability
- A abertura do projeto não depende mais do carregamento de provedores; o seletor de modelos é hidratado em segundo plano.
- Carregamento de provedores tem timeout de 7–8 segundos para não travar a UI.
- Criação de sessão OpenCode tem timeout explícito.
- Health checks e chamadas do GitHub possuem timeout para evitar requests penduradas.
- Atualização de projetos recentes não regrava o histórico a cada polling de status.


## v0.4.10 — TypeScript Fix 2
- Corrigido o `TS18046` em `session.data` com narrowing explícito, preservando o comportamento existente da criação de sessão OpenCode.


## v0.4.11 — Recent Projects + Plan + Popup UX
- Projetos recentes agora são validados contra o filesystem; pastas removidas são eliminadas automaticamente do histórico.
- Se o projeto atual desaparecer do disco, o Neko limpa o workspace, encerra a sessão e remove o projeto dos recentes.
- Desconectar GitHub também limpa imediatamente o contexto de repositório/branch da interface.
- Implementado modo Plan no composer, alternável pelo botão `Plan` ou pela tecla Tab.
- Plan mode usa o agente `plan` do OpenCode e instrui o agente a não modificar arquivos.
- Popups e dropdowns fecham ao clicar fora; modais também fecham com clique no backdrop.


## v0.4.12 — Git Clone + Providers
- Repositórios GitHub podem ser clonados localmente antes da abertura do projeto; o remote é sanitizado logo após o clone para não deixar a chave no `origin`.
- O botão de clone aparece quando não existe projeto local; com projeto aberto, a ação continua sendo vincular.
- Corrigida a função ausente `connectProvider`.
- Adicionado desconectar de provider usando `DELETE /auth/:providerID`, API documentada do OpenCode.
- Providers agora são organizados em `Popular` e `Outros`, com badge verde `Conectado` e ações explícitas de conectar/desconectar.
- Modelos ativos agora são agrupados por provider no gerenciamento de modelos.
- Logo reduzido para evitar corte mantendo o logotipo completo visível.


## v0.4.13 — Provider UX Refinement
- Corrigidos os imports ausentes `Download` e `Unlink`.
- Corrigida a emissão de eventos de preview após o BrowserWindow ser destruído.
- Modelos agora mostram somente providers conectados, agrupados em cartões visualmente separados.
- Cada provider conectado possui um toggle próprio para ativar/desativar todos os seus modelos.
- O estado do provider é persistido em `provider-settings.json`.
- A lista de modelos continua permitindo controle individual por modelo.
- Janela de providers recebeu uma hierarquia visual mais clara: Mais populares em cards e Outros em lista separada, com badge Conectado e ação de desconectar.
- Ícones de marca são usados em SVG no lugar de caracteres/Alt Code.


## v0.4.13 — Runtime JSX scope fix
- Corrigido o modal de providers que havia sido inserido fora do componente `App`, causando `modal is not defined` em runtime.


## v0.4.14 — Stability / Modal / Provider / Clone Fix
- Corrigida emissão de eventos de preview após destruição da janela Electron.
- Clone GitHub usa `http.extraHeader` para autenticação e restaura `origin` sem credenciais.
- Modais de modelos e providers ganharam área de scroll interna, altura máxima e pesquisa fixa.
- Mais populares passou a ser uma lista, não cards.
- Providers e modelos receberam hierarquia visual em linhas/cartões claramente separados.
- Ações de conectar/desconectar ficaram explícitas.
- Corrigido o posicionamento do modal de providers dentro do `App`.


## v0.4.15 — Full Provider / Clone UX Stabilization
- Modal de modelos e modal de providers foram reconstruídos com shell fixo e um único scroll interno, evitando corte e scroll aninhado.
- Mais populares permanece em lista, visualmente separada de Outros.
- Provider disconnect tenta primeiro o método oficial do SDK do OpenCode e usa o endpoint HTTP como fallback.
- Clone do GitHub tenta Git Smart HTTP e, se a autorização do App impedir o clone Git, usa o zipball autenticado da API do GitHub e materializa o projeto localmente.
- `emitPreview` agora verifica `BrowserWindow` e `webContents` antes de enviar eventos.


## v0.4.15 — Clone TypeScript Fix 2
- Adicionado `node:os` para uso de `os.tmpdir()`.
- Corrigido o fallback de extração do clone para respeitar o retorno `void` do helper `runCommand`, usando `try/catch` em vez de acessar `.code`.


## v0.4.16 — Provider Modal / Clone Real Fix
- Replaced the previous provider/model modal JSX rather than relying only on CSS overrides.
- Provider lists are single-column rows; no popular-provider card grid.
- Added dedicated internal scrolling containers for models and providers.
- Search fields are isolated from inherited input sizing rules.
- Git clone now uses GitHub Smart HTTP Basic authentication with `x-access-token` and falls back to an authenticated archive when necessary.
- Archive fallback initializes a local Git repository and configures origin.

## v0.4.19 — Model Picker synchronization

- Added an explicit `neko.opencode.ready` renderer event emitted only after the project OpenCode server passes `/global/health`.
- The model/provider catalog is reloaded at OpenCode readiness instead of racing startup.
- Provider/model state is cleared before switching projects, preventing stale models from the previous project from remaining visible.
- Provider IPC now returns an empty catalog when no project/OpenCode instance exists, avoiding `ECONNREFUSED` during the empty state.
- The approved Model Picker layout is unchanged in this phase.


## v0.4.25 — Project Chat History
- Reutiliza a sessão mais recente do NekoAI por projeto, quando disponível.
- Restaura o histórico persistido do OpenCode ao reabrir o projeto.
- Mantém o OpenCode como fonte de verdade, sem duplicar o transcript em um banco paralelo.


## v0.4.26 — Plan Timeout + Model Visibility Fix
- Plan Mode usa `prompt_async` e aguarda o ciclo da sessão até 10 minutos, evitando o timeout fixo de 180s.
- O modal de gerenciamento usa `managedModels`, mantendo modelos desativados visíveis.
- O seletor do chat continua usando apenas modelos conectados e ativos.


## v0.4.27 — Plan Event/Response Fix
- O Plan não depende mais do timeout de 180s nem de `session.status` para reconhecer a resposta.
- Registra as mensagens existentes antes do envio e aguarda uma nova mensagem do assistant.
- Lê o transcript diretamente pelo endpoint de mensagens e aceita conclusão por status idle ou texto estável.
- Mantém o limite de 10 minutos somente como proteção extrema.
- O comportamento dos modelos gerenciados/ativos da v0.4.26 foi preservado.


## v0.4.36 — Official Provider Icons
- ProviderIcon usa o sprite oficial do @opencode-ai/ui.
- IDs especiais são normalizados para os nomes oficiais do catálogo.
