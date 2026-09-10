# NekoAI v0.4.48 — GitHub App Authorization Fix

## Objetivo
Corrigir o fluxo de autorização do GitHub para usar corretamente User Access Tokens de GitHub Apps.

## Correções
- Removido `scope: "repo"` do Device Flow.
- Removida a verificação de `X-OAuth-Scopes` como critério de autorização.
- Permissões efetivas agora são avaliadas pelas permissões da instalação do GitHub App em `/user/installations`.
- `Contents: write` é tratado como capacidade necessária para clone/fetch/push.
- `Administration: write` é tratado como capacidade necessária para criar/publicar repositórios.
- A interface não entra mais em loop de “Atualização de autorização necessária” para User Access Tokens de GitHub Apps.
- Quando faltarem permissões reais, o Neko mostra um aviso de permissões e direciona o usuário para revisar a instalação do App.
- Sessão persistente e refresh token permanecem inalterados.
- Clone verdadeiro, GIT_ASKPASS, Commit/Push e ciclo de projeto permanecem preservados.

## Fluxo esperado
1. Autorizar o GitHub App uma vez via Device Flow.
2. Reutilizar a sessão para listar, clonar, publicar, fetch e push.
3. Se permissões do App forem alteradas, o GitHub exige aprovação; após a aprovação, o Neko lê as novas permissões da instalação.
4. Não solicitar novamente o Device Flow apenas porque `scope` está vazio — User Access Tokens de GitHub Apps não usam scopes tradicionais.
