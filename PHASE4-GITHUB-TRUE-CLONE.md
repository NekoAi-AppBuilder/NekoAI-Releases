# NekoAI — Fase 4.3 — GitHub Clone verdadeiro

## v0.4.44

Esta versão fecha a etapa de Clone Git verdadeiro sem alterar a interface do GitHub.

### Alterações

- O clone usa exclusivamente `git clone` autenticado.
- O token do GitHub continua fora da linha de comando, URLs e `.git/config`.
- A autenticação do Git usa `GIT_ASKPASS` temporário.
- O token é recuperado de forma segura e renovado quando necessário.
- Falhas de clone não são mais convertidas silenciosamente em ZIP.
- Um clone com falha remove uma pasta parcial criada durante a tentativa.
- O resultado é validado com `git rev-parse` para garantir que existe um repositório Git real.
- O `origin` é validado e mantido sem credenciais.
- Branches remotas são atualizadas usando autenticação do GitHub.
- Checkout de branch remota usa `ls-remote` + `fetch` autenticados.
- Vinculação de projeto valida o acesso ao repositório antes de alterar o `origin`.
- Erros comuns de autenticação, permissão, repositório inexistente e rede são convertidos em mensagens próprias do NekoAI.

### Regra arquitetural

**Clone** significa clone Git real, com `.git`, histórico, referências, branches e remote.

Importação por ZIP não faz parte do fluxo de Clone e permanece reservada para uma futura função separada de **Importar projeto**.


## v0.4.45 — Fluxo GitHub integrado

- Novo fluxo de clone confirmado dentro do NekoAI antes da escolha da pasta.
- O seletor de pasta do Windows serve apenas para escolher o destino; o projeto não depende do Explorer para iniciar o workspace.
- Após clone real, o Neko abre a pasta no Explorer e carrega o projeto no workspace.
- Projetos clonados permanecem conectados pelo `.git` + `origin` e podem ser reabertos pelo seletor de pastas/recentes.
- Modal principal do GitHub passa a mostrar o projeto conectado, branch, estado local e ação `Commit e Push`.
- Commit usa `git add -A` + `git commit`; push usa `GIT_ASKPASS` temporário, sem token em argumentos/URL/config.
- Identidade Git local é preenchida apenas quando ausente, usando login/e-mail noreply derivado da conta GitHub.
- `Novo Projeto` agora abre um modal Neko para nome + pasta principal; o Explorer é usado somente para selecionar o diretório pai.
- A autenticação do navegador não é repetida para operações Git: clones/push/fetch usam a credencial segura já armazenada pelo Device Flow.
