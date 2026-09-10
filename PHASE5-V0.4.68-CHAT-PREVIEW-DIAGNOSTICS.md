# Fase 5 — v0.4.68

## Objetivo
Corrigir a ordem temporal do chat, tornar os diagnósticos do Preview realmente úteis, aplicar a identidade Neko às scrollbars do conteúdo externo/embutido e ocultar detalhes do motor interno.

## Escopo
- Timeline do chat baseada em timestamps.
- Planos inseridos na posição correta da conversa.
- Console/Erros alimentados pelo Preview.
- Logs de execução traduzidos para linguagem Neko.
- Scrollbar Neko no iframe e na janela externa.
- Remoção do cabeçalho redundante do chat.

## Não alterar
- Providers/Model Picker.
- GitHub.
- Ciclo de retry/execução contínua já existente.
- Comportamento de múltiplos projetos.

## Privacidade
Nenhum nome do motor interno, payload, endpoint, evento ou detalhe de implementação deve aparecer nos painéis visíveis ao usuário.

## Validação
Executar `npm run build`, abrir um projeto com Preview, provocar log/warning/erro, conferir as três abas do terminal e testar o Preview embutido e externo.
