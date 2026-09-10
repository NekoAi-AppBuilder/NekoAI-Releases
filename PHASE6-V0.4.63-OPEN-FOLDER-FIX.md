# NekoAI v0.4.63 — Abrir pasta existente no seletor

- Corrigido o botão `Abrir nova pasta` dentro do seletor quando não existe projeto aberto.
- O botão agora usa exclusivamente o fluxo `openOtherProject()`.
- O fluxo abre o seletor de pastas do Windows e abre a pasta existente diretamente.
- Removido `createDirectory` do diálogo `project:choose`, evitando que esse fluxo seja confundido com criação de projeto.
- `Novo Projeto` permanece separado e continua usando o fluxo de criação com nome + pasta pai.
- Nenhuma outra funcionalidade foi alterada nesta correção.
