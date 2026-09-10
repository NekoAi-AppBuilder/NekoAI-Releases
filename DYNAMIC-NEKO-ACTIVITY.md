# v0.4.34 — Atividade dinâmica do Neko

O indicador de execução do chat agora representa a ação real em andamento, em vez de mostrar uma etapa genérica.

Exemplos:
- `Editando src/components/Pricing.jsx...`
- `Analisando src/components/App.jsx...`
- `Analisando os arquivos do projeto...`
- `Executando os testes...`
- `Verificando a compilação do projeto...`
- `Configurando as dependências...`
- `Alteração aplicada em src/components/Pricing.jsx...`

A interface não exibe nomes internos do OpenCode, MCP ou ferramentas. Os eventos do motor são traduzidos para mensagens da NekoAI.

A implementação usa tanto `tool.execute.before/after` quanto `message.part.updated` quando este último fornece o estado de uma ferramenta, aumentando a compatibilidade entre versões do motor.
