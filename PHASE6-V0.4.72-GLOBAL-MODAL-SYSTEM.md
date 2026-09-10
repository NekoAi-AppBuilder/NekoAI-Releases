# NekoAI v0.4.72 — Fase 6: Sistema Global de Modais

## Implementado nesta versão:

1. **Padronização Dimensional (500px)**:
   - Todos os modais da aplicação agora utilizam rigorosamente a largura padrão de **500px** (`width: min(500px, calc(100vw - 32px))`, `max-width: 500px`).
   - Altura contida e proporcional (`max-height: min(640px, calc(100vh - 48px))`), eliminando layouts espalhados ou esticados.

2. **Acessibilidade & Semântica**:
   - Containers modais equipados com `role="dialog"`, `aria-modal="true"` e `aria-labelledby="modal-title"`.
   - Suporte universal a teclado: tecla `Escape` fecha o modal ativo ou retorna ao modal anterior em fluxos encadeados (ex: `providerAuth` → `providers` → `models`, ou `githubClone`/`githubPublish`/`githubLink` → `github`).
   - Foco automático nos inputs de busca e autenticação ao abrir.

3. **Arquitetura Modular Homogênea**:
   - `modal-head`: Cabeçalho unificado com título semântico, subtítulo descritivo, botão Voltar (`back-btn`) e botão Fechar (`close-btn`).
   - `modal-search-wrap`: Barra de pesquisa compacta e padronizada.
   - `modal-scroll-body`: Área de rolagem com scrollbar Neko fina, sem salto de layout e com contenção de overscroll.
   - `modal-actions` / `auth-actions`: Rodapé com alinhamento e botões de ação consistentes (`.secondary`, `.primary`).

4. **Transições Visuais**:
   - Backdrop escuro com `backdrop-filter: blur(4px)` e animação suave de fade-in.
   - Animação de escala suave (`scale-in` de 0.97 para 1.0) para entrada do diálogo.
   - Fechamento seguro ao clicar fora no overlay sem propagação para o conteúdo interno.

5. **Modais Cobertos**:
   - `models` (Gerenciar modelos)
   - `providers` (Conectar provedor)
   - `providerAuth` (Autenticação de provedor com chave de API)
   - `github` (Conexão e painel do GitHub)
   - `githubDevice` (Autorização via Device Code)
   - `githubLink` (Vincular projeto local ao GitHub)
   - `githubClone` (Clonar repositório para novo projeto)
   - `githubPublish` (Publicar projeto local no GitHub)
   - `newProject` (Criar novo projeto local)

---

## Validação:
- [x] Compilação `npm run build` executada com sucesso.
- [x] 9 modais padronizados com estrutura única e 500px de largura.
- [x] Captura e tratamento de `Escape` para fechar e voltar.
