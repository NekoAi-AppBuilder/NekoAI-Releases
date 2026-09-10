# NekoAI — Fase 4.4 GitHub Project Lifecycle

## Objetivo

Unificar o ciclo de vida de projetos locais e projetos vindos do GitHub.

## Fluxos

### Novo projeto local
1. Usuário escolhe `Novo Projeto`.
2. Informa nome do projeto.
3. Escolhe pasta pai.
4. Neko cria a pasta e abre o projeto.
5. O projeto permanece local e sem GitHub até o usuário escolher publicar.

### Publicar projeto local
1. Projeto local aberto e sem `origin`.
2. GitHub já conectado ou Device Flow se necessário.
3. Usuário escolhe `Publicar no GitHub`.
4. Informa nome do repositório e visibilidade.
5. Neko inicializa Git se necessário.
6. Neko cria o repositório remoto.
7. Configura `origin`, cria o primeiro commit e faz `push`.
8. O projeto passa a ser tratado como projeto GitHub conectado.

### Clonar projeto GitHub
1. Conta GitHub conectada uma única vez.
2. Usuário escolhe um repositório.
3. Neko abre o modal padrão de criação de projeto com nome + pasta.
4. O clone usa o nome informado como pasta local e como nome interno do projeto no Neko.
5. O clone é Git verdadeiro, preservando histórico, branches e `origin`.
6. Projeto é aberto no Neko e o Explorer pode ser aberto como ação complementar.

## Regra de autenticação

`github:start` reutiliza a sessão existente. Clone, fetch, checkout, push e publicação não iniciam novo Device Flow. Credenciais Git são fornecidas temporariamente via `GIT_ASKPASS`.

## Regra de estado

- Projeto local sem GitHub: `Projeto local` / ação `Publicar no GitHub`.
- Projeto conectado: `Projeto conectado` / `Commit e Push`.
- Projeto local existente com `.git` + `origin`: detectar e apresentar como conectado quando o remote for reconhecido.

## Escopos

A autorização do OAuth Device Flow solicita `repo`, necessário para criar e escrever em repositórios públicos/privados via OAuth. Tokens antigos emitidos antes desta solicitação podem precisar de uma nova autorização única para receber o escopo adicional.
