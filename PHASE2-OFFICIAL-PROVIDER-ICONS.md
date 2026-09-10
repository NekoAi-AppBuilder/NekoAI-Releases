# v0.4.39 — Ícones oficiais de providers

A NekoAI agora usa o sprite oficial de `@opencode-ai/ui`, empacotado localmente durante o build.

- `npm install` instala `@opencode-ai/ui@1.18.18`.
- `npm run build` executa `npm run sync:provider-icons` antes do Vite.
- O script copia `src/components/provider-icons/sprite.svg` do pacote oficial para os assets da NekoAI.
- O renderer injeta o sprite no DOM e usa `<use href="#provider-id">`, sem CDN e sem requisições externas.
- O catálogo inclui todos os nomes oficiais presentes no `provider-icons/types.ts`.
- Providers não reconhecidos usam o ícone genérico Sparkles da NekoAI, nunca letras como `AL` ou `DE`.

Fonte oficial: https://github.com/anomalyco/opencode/tree/dev/packages/ui/src/components/provider-icons
