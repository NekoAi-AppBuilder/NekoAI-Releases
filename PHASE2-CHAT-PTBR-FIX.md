# NekoAI v0.4.33 — Saída PT-BR sem duplicação

Correção da saída do chat para evitar respostas bilíngues.

- O prompt do agente exige uma única resposta final em Português do Brasil.
- A sincronização do histórico não concatena mais todas as partes de texto de uma mensagem do agente.
- A última parte de texto é tratada como resposta final do usuário, evitando que uma confirmação/progresso interno em inglês seja exibido junto.
- Quando ainda houver múltiplos parágrafos misturados, a camada de apresentação remove parágrafos predominantemente em inglês quando existe conteúdo claramente em português.
- Termos internos do motor continuam sendo sanitizados antes de chegar ao chat.

Validação no Windows:

```powershell
npm install
npm run build
npm start
```
