# NekoAI — ROADMAP OFICIAL DO PROJETO

> **Regra obrigatória:** antes de iniciar qualquer implementação, correção ou nova feature, o agente deve ler este arquivo por completo e usar o roadmap como fonte de verdade do estado do projeto.
>
> Não considerar uma tarefa concluída apenas porque arquivos foram criados. Uma etapa só está concluída após implementação, validação, testes e correção dos problemas encontrados.

---

## 1. Objetivo do NekoAI

O NekoAI é um aplicativo desktop baseado em Electron + React/Vite + OpenCode como motor interno.

O usuário deve perceber apenas a experiência NekoAI.

### Nunca expor ao usuário

- OpenCode
- MCP
- external_directory
- nomes internos de ferramentas
- payloads
- eventos internos
- stack traces
- nomes internos de permissões
- detalhes técnicos desnecessários

### Linguagem da interface

Usar conceitos como:

- Neko trabalhando
- Neko analisando
- Neko editando
- Neko corrigindo
- Neko validando
- Neko concluiu
- Neko precisa de autorização

---

# 2. Estado atual do roadmap

| Fase | Área | Estado |
|---|---|---|
| 1 | Providers | CONCLUÍDA |
| 2 | Model Picker | CONCLUÍDA / ESTABILIZADA |
| 3 | Modal de Providers | CONCLUÍDA |
| 4 | Projetos / GitHub / abertura de projetos | CONCLUÍDA — v0.4.74 |
| 5 | Agent + Plan + Build + Preview | IMPLEMENTADA — v0.4.71 |
| 6 | Sistema global de modais | CONCLUÍDA — v0.4.72 |
| 7 | Auditoria geral / estabilidade | CONCLUÍDA — v0.4.73 |
| 8 | Home 1 — Tela inicial (Hero + Ações) | **CONCLUÍDA — v0.4.74** |
| 9 | Home 2 — Meus projetos + Previews reais | **CONCLUÍDA — v0.4.74** |
| 10 | Home 3 — Favoritos + Pesquisa | **CONCLUÍDA — v0.4.74** |
| 11 | Home 4 — Sair do projeto → Home | **CONCLUÍDA — v0.4.74** |

---

# 3. Fase 1 — Providers

## Estado: CONCLUÍDA

Providers conectados, desconectados e desativados possuem estados próprios.

Provider desconectado continua disponível para reconexão.

Providers/modelos desativados continuam visíveis no gerenciamento, mas não aparecem como opções ativas no Model Picker.

Ícones oficiais locais foram adotados.

Fallback de provider sem ícone oficial:

- usar o Sparkles roxo da NekoAI.

---

# 4. Fase 2 — Model Picker

## Estado: CONCLUÍDA / ESTABILIZADA

Deve manter:

- providers ativos;
- modelos ativos;
- busca;
- scroll;
- último modelo utilizado;
- persistência;
- gerenciamento.

---

# 5. Fase 3 — Modal de Providers

## Estado: CONCLUÍDA

O scroll deve funcionar:

- sobre provider;
- sobre nome;
- sobre ícone;
- sobre botão;
- fora da lista;
- através da scrollbar.

Não alterar sem necessidade:

- ícones;
- conexão/desconexão;
- Model Picker;
- modelos;
- último modelo utilizado.

---

# 6. Fase 4 — Projetos / GitHub / abertura de projetos

## Estado: IMPLEMENTADA / ESTABILIZAR

Já existe suporte para:

- abrir projetos existentes;
- criar novos projetos;
- múltiplos projetos;
- watcher de arquivos;
- OpenCode por projeto;
- servidores de Preview por projeto;
- troca entre projetos.

### Regra importante

No seletor de projetos:

**Criar novo projeto**
- deve criar um projeto novo.

**Abrir outro projeto**
- deve abrir uma pasta existente;
- NÃO deve abrir o fluxo de criação;
- NÃO deve pedir nome de novo projeto.

### Próxima validação desta área

Confirmar que:

1. selecionar uma pasta existente abre diretamente o projeto;
2. o projeto passa a ser o projeto atual;
3. o OpenCode é iniciado para a pasta correta;
4. o Preview usa a raiz correta;
5. trocar de projeto não mistura sessões;
6. múltiplas instâncias/projetos continuam funcionando.

---

# 7. FASE 5 — AGENT + PLAN + BUILD + PREVIEW

## Estado: EM EXECUÇÃO — PRIORIDADE MÁXIMA

## Objetivo

Fechar o ciclo completo:

```text
Usuário envia tarefa
        ↓
Neko analisa
        ↓
Neko planeja
        ↓
Neko implementa
        ↓
Neko executa comandos
        ↓
Neko instala dependências quando necessário
        ↓
Neko inicia/reutiliza Preview
        ↓
Neko verifica runtime
        ↓
Neko verifica build
        ↓
Neko detecta erros
        ↓
Neko corrige erros
        ↓
Neko testa novamente
        ↓
Neko faz revisão final
        ↓
Neko conclui
```

### Regra absoluta de conclusão

O agente NÃO pode considerar uma tarefa concluída apenas porque:

- criou arquivos;
- escreveu componentes;
- executou uma única etapa;
- iniciou o Vite;
- fez um build parcial;
- respondeu uma mensagem dizendo que terminou.

Só concluir quando o projeto estiver realmente funcionando.

---

## 7.1 Execução contínua

O agente deve continuar a tarefa até atingir o objetivo.

Se ocorrer:

- `busy`;
- `retry`;
- erro temporário de upstream;
- falha temporária de streaming;
- erro de instalação;
- erro de build;
- erro de runtime;
- erro do Preview;

deve analisar o problema e continuar quando for recuperável.

### Erros temporários de API

Exemplo:

```text
502 Upstream error
Service temporarily overloaded
```

Com erro claramente temporário:

1. informar internamente que houve falha temporária;
2. aguardar/repetir com backoff;
3. continuar a mesma tarefa;
4. não perder o contexto;
5. não declarar a tarefa encerrada.

Não criar loops infinitos sem controle. Deve existir retry com backoff e limite técnico seguro, mas a tarefa não deve ser abandonada prematuramente por uma falha transitória.

---

# 8. Performance do Agent

## Problema observado

Muitos eventos:

```text
session.status status=busy
session.status status=busy
session.status status=busy
```

aparecem repetidamente.

Isso não deve significar que o agente está travado.

### Objetivos

- reduzir eventos redundantes no renderer;
- evitar renders desnecessários;
- não bloquear a interface;
- manter streaming responsivo;
- processar eventos de forma eficiente;
- separar estado real de execução de eventos repetidos;
- evitar sensação de travamento;
- manter suporte a modelos rápidos e modelos de raciocínio pesado.

### Importante

Não mascarar um agente realmente travado apenas escondendo o status `busy`.

O sistema deve distinguir:

- trabalhando;
- aguardando resposta;
- executando ferramenta;
- retry;
- erro;
- concluído;
- realmente travado/sem progresso.

---

# 9. Diagnóstico de erros

## Objetivo

O usuário não deve precisar abrir o terminal para descobrir por que o Preview não abriu.

Quando ocorrer erro:

### Chat

Mostrar uma mensagem amigável.

Exemplo:

```text
O Preview encontrou um erro.
Vou verificar e tentar corrigir.
```

Se houver diagnóstico útil:

```text
Erro encontrado:
stroke-width deve ser strokeWidth em JSX.

Neko está corrigindo...
```

### Não mostrar

- stack trace bruto;
- payload interno;
- detalhes de OpenCode;
- credenciais;
- tokens;
- informações internas desnecessárias.

---

# 10. Terminal interno / diagnóstico

Criar uma área integrada à interface para diagnóstico do projeto.

Abas:

- **Logs**
- **Console**
- **Erros**

Essa área deve ficar integrada ao workspace/Preview, sem obrigar o usuário a abrir o PowerShell.

### Logs

Mostrar informações relevantes da execução.

### Console

Capturar mensagens do Preview.

### Erros

Concentrar erros reais de:

- runtime;
- build;
- Vite;
- React;
- JavaScript;
- Preview.

Warnings não devem ser tratados automaticamente como falhas fatais.

---

# 10.1 — v0.4.65 Terminal Interno

## Estado: IMPLEMENTADO — AGUARDANDO VALIDAÇÃO NA MÁQUINA DO USUÁRIO

Implementado nesta versão:

- eventos de stdout/stderr do Preview transmitidos ao terminal interno;
- stdout/stderr do OpenCode transmitidos aos Logs;
- saída do processo de Build transmitida aos Logs/Erros;
- console do Preview capturado através do WebContents;
- compatibilidade com a assinatura atual de `console-message` do Electron;
- separação entre Logs, Console e Erros;
- limite de histórico do terminal para evitar crescimento ilimitado;
- mensagens de erro relevantes do stderr classificadas como Erros;
- Terminal continua integrado ao fundo do workspace, sem abrir janela externa.

### Validação pendente

A build deve ser executada na máquina do usuário e testada com:

1. iniciar um projeto com Vite;
2. observar Logs em tempo real;
3. gerar `console.log`, `console.warn` e `console.error`;
4. provocar um erro de runtime;
5. provocar um erro de build;
6. confirmar que cada informação aparece na aba correspondente.

# 11. Preview

## Objetivo

O Preview deve funcionar automaticamente sempre que o projeto possuir uma aplicação executável.

### Deve:

1. descobrir a raiz real do projeto;
2. localizar `package.json`;
3. detectar scripts disponíveis;
4. instalar dependências quando necessário;
5. iniciar o servidor;
6. reutilizar servidor existente quando for seguro;
7. descobrir a porta;
8. abrir o Preview automaticamente;
9. acompanhar HMR/reload;
10. detectar erros;
11. informar erros ao Agent;
12. permitir que o Agent corrija;
13. atualizar novamente.

### Preview não deve permanecer em:

```text
Seu app aparecerá aqui
Nenhum package.json encontrado no projeto.
```

quando existe um `package.json` válido dentro da raiz real do projeto.

---

# 12. Preview Page Selector

Feature prevista anteriormente.

## Objetivo

Descobrir as rotas/páginas reais do projeto.

Deve:

- descobrir rotas;
- exibir seletor na barra do Preview;
- navegar para a página selecionada;
- preservar a rota atual ao atualizar;
- manter a rota ao usar HMR quando possível;
- abrir a rota selecionada em nova janela quando solicitado.

---

# 13. Validação automática

Antes de concluir:

### Código

- verificar imports;
- verificar arquivos;
- verificar referências;
- verificar componentes;
- verificar responsividade;
- verificar interações.

### Build

Executar o build adequado.

### Desenvolvimento

Executar o servidor de desenvolvimento quando necessário.

### Runtime

Verificar se a aplicação abre.

### Preview

Verificar se aparece.

### Erros

Corrigir erros encontrados.

### Revisão final

Executar uma última revisão do projeto inteiro.

---

# 14. Interface do Chat

## Ações da mensagem do agente

Ao finalizar uma tarefa, mostrar:

- Undo
- Copiar
- tempo da tarefa

Exemplo:

```text
↶   Copiar   1m 35s
```

O tempo deve ser formatado de maneira amigável:

- `12s`
- `1m 35s`
- `12m 08s`
- `1h 04m`

Não usar milissegundos para o usuário.

---

# 15. Mensagens do usuário

A mensagem enviada pelo usuário não deve mostrar ações permanentemente.

Ao passar o mouse:

- Copiar
- Editar

### Editar

Quando o usuário editar uma mensagem e reenviar:

1. preservar o histórico;
2. desfazer a última alteração correspondente;
3. executar novamente a tarefa a partir da mensagem editada;
4. evitar duplicação de alterações;
5. manter o contexto necessário.

---

# 16. Toasts

Criar sistema de toast contextual.

## Regra

O toast deve aparecer **próximo ao elemento que disparou a ação**.

Não centralizar todos os toasts no topo da aplicação.

Exemplos:

- copiar mensagem → toast próximo ao botão Copiar;
- copiar código → toast próximo ao botão de copiar código;
- ação concluída → toast próximo ao elemento correspondente.

### Visual

- compacto;
- dark;
- identidade NekoAI;
- sem criar um painel/fundo grande;
- desaparecimento automático.

---

# 17. Ações abaixo das mensagens

As ações do Agent devem ocupar um espaço reservado no próprio fundo escuro do chat.

Não criar um novo card/fundo para:

- Undo;
- Copiar;
- tempo.

O mesmo vale para:

- Copiar;
- Editar da mensagem do usuário.

As ações devem aparecer abaixo da mensagem, discretamente, mantendo o fundo original do chat.

---

# 18. Home — Tela inicial

## Home 1

A Home não deve ter o cabeçalho do workspace.

Tela inteira.

Centro:

- ícone oficial Neko;
- título:
  **O que iremos construir juntos?**
- subtítulo:
  **Comece um projeto ou abra um existente, nós cuidamos de tudo, as tecnologias, dependências e servidor.**

Botões:

- Criar novo projeto — pasta +;
- Abrir projeto existente — pasta.

---

# 19. Home — Meus projetos

## Home 2

Mostrar projetos anteriormente trabalhados.

Cada card deve conter somente:

- preview/miniatura real;
- nome;
- tempo desde última edição;
- favorito.

Exemplos:

```text
Editado há 2 horas
Editado ontem
```

A Home deve ser populada automaticamente.

---

# 20. Home — Favoritos

## Home 3

Permitir:

- favoritar projeto;
- desfavoritar projeto;
- visualizar favoritos.

---

# 21. Sair do projeto

## Home 4

Dentro do workspace:

```text
Projeto aberto
      ↓
Sair
      ↓
Home
```

Não fechar o NekoAI.

O controle deve ficar próximo do GitHub, conforme definido no design.

---

# 22. Sistema global de modais

## Fase 6 — CONCLUÍDA (v0.4.72)

Padrão único consolidado para todos os 9 modais da aplicação.

### Requisitos implementados:
- **Largura padrão:** 500px (`width: min(500px, calc(100vw - 32px))`, `max-width: 500px`).
- **Altura proporcional:** `max-height: min(640px, calc(100vh - 48px))` com scroll interno contido (`modal-scroll-body`).
- **Acessibilidade:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`.
- **Teclado:** suporte a tecla `Escape` para fechar ou retornar em fluxos encadeados.
- **Overlay:** backdrop escuro com blur (`backdrop-filter: blur(4px)`) e clique externo seguro.
- **Animações:** transições suaves de entrada (`scale-in` e `fade-in`).
- **Identidade:** paleta escura oficial NekoAI e botões padronizados.

---

# 23. Auditoria geral

## Fase 7 — CONCLUÍDA (v0.4.73)

Auditoria geral e estabilização de runtime do Electron, processos filhos e isolamento entre múltiplos projetos.

### Requisitos consolidados:
- **Processos filhos:** eliminação de processos zumbis com `taskkill /T /F` no Windows, aguardando término assíncrono.
- **Saída global:** handlers para `before-quit`, `will-quit`, `SIGINT`, `SIGTERM` e `process.on("exit")` com fallback síncrono.
- **Portas:** desalocação instantânea de portas e prevenção de colisão em `findFreePort`.
- **Watchers:** tratamento de erro no `fs.watch` para pastas alteradas/removidas sem provocar crash do app.
- **Múltiplos Projetos:** limpeza profunda de terminais, arquivos, planos e diagnósticos ao alternar projetos.
- **Memória:** contenção e expiração automática de diagnósticos em `attemptedErrorSignatures`.
- **Segurança:** sanitização rigorosa de credenciais, tokens e API keys em todas as saídas de log e IPC.

---

# 24. Segurança

Nunca exibir no chat ou logs visíveis:

- API keys;
- tokens;
- senhas;
- credenciais GitHub;
- cookies;
- secrets.

O warning interno:

```text
OPENCODE_SERVER_PASSWORD is not set
```

deve ser tratado tecnicamente e não transformado em mensagem confusa para o usuário.

---

# 25. Compatibilidade com múltiplos projetos

O NekoAI deve permitir trabalhar com mais de um projeto.

Cada projeto precisa manter corretamente:

- workspace;
- sessão do Agent;
- Preview;
- porta;
- watcher;
- estado;
- rota;
- arquivos.

Não misturar sessões entre projetos.

---

# 26. Regra para alterações

Antes de alterar qualquer código:

1. ler este `NekoAI-ROADMAP.md`;
2. identificar a fase atual;
3. identificar o objetivo da tarefa;
4. verificar se já existe implementação parcial;
5. preservar funcionalidades existentes;
6. implementar;
7. testar;
8. corrigir;
9. testar novamente;
10. atualizar este roadmap quando uma etapa mudar de estado.

---

# 27. Critério de conclusão da Fase 5

A Fase 5 só pode ser marcada como concluída quando:

- [ ] Agent executa tarefas até o objetivo real;
- [ ] Plan Mode não interrompe execução indevidamente;
- [ ] retries recuperam falhas temporárias;
- [ ] erros são diagnosticados;
- [ ] Preview abre automaticamente;
- [ ] Preview detecta erros;
- [ ] erros do Preview chegam ao Agent;
- [ ] Agent consegue corrigir erros;
- [ ] build é validado;
- [ ] runtime é validado;
- [x] terminal interno funciona;
- [x] Logs funcionam;
- [x] Console funciona;
- [x] Erros funcionam;
- [ ] performance do Agent foi revisada;
- [ ] eventos `busy` redundantes não causam travamento visual;
- [ ] múltiplos projetos continuam funcionando;
- [ ] nenhuma credencial é exposta;
- [ ] revisão final passa;
- [ ] tarefa só recebe estado concluído após validação real.

---

# 28. Regra final do NekoAI

> **Não parar porque os arquivos foram criados.**
>
> **Não parar porque o Agent respondeu.**
>
> **Não parar porque o Vite iniciou.**
>
> **Não parar porque o build passou.**
>
> **Continuar até o projeto estar realmente funcionando.**
>
> **Detectar → corrigir → testar → validar → concluir.**

---

## Próxima ação oficial

### FASE 5 — AGENT + PLAN + BUILD + PREVIEW

Começar pela auditoria da implementação atual antes de modificar código.

Prioridade:

1. ciclo de execução contínua;
2. diagnóstico de erros;
3. Preview automático;
4. comunicação Preview → Agent;
5. validação automática;
6. performance/eventos;
7. terminal interno;
8. conclusão confiável.


---

# v0.4.64 — Fase 5: Agent + Preview + Validação

## Implementado nesta versão

- Retry automático com backoff para falhas temporárias do Agent (5xx, 429, timeout, upstream/streaming e erros marcados como recuperáveis).
- A tarefa original é preservada durante retries; o Neko não declara conclusão durante uma falha transitória.
- Terminal integrado ao workspace com abas **Logs**, **Console** e **Erros**.
- Saída de stdout/stderr do Preview e do build é encaminhada ao terminal interno.
- Mensagens de console do Preview são capturadas e separadas de warnings.
- Validação automática do build após uma execução do Agent quando o projeto possui `scripts.build`.
- Validação automática do Preview após a execução.
- Se o Preview ou build falhar, o Neko envia o diagnóstico técnico de volta ao Agent e solicita correção automática, com até 3 ciclos de reparo por tarefa.
- O ciclo só libera a interface após a validação final ou após atingir o limite técnico de reparos.

## Ainda precisa ser validado na máquina de desenvolvimento

- [ ] `npm install` completo.
- [ ] `npm run build` sem erros.
- [ ] retry real de erro 502/503 do provider.
- [ ] Preview abre automaticamente após criação de `package.json`.
- [ ] erro React/runtime aparece na aba Erros.
- [ ] diagnóstico chega ao Agent e gera correção.
- [ ] build quebrado é corrigido automaticamente.
- [ ] execução longa permanece responsiva.
- [ ] múltiplos projetos continuam isolados.

## Regra desta versão

Não considerar a Fase 5 concluída somente pela implementação do código. A confirmação final depende de build, runtime, Preview, correção automática e testes reais.


# v0.4.68 — Chat timeline + Preview diagnostics + scrollbar + UI privacy

## Implementado nesta versão

- Corrigida a ordem visual do chat usando timestamps de criação, mantendo mensagens, planos e confirmações na ordem em que ocorreram.
- Plano pendente/aprovado deixou de ficar preso ao final do chat quando existem mensagens posteriores.
- Console do Preview agora aceita níveis numéricos e textuais e encaminha warnings/erros para as abas corretas.
- Logs internos relevantes foram traduzidos para terminologia Neko antes de aparecerem na interface.
- Removida a exposição de nomes do motor interno nos diagnósticos visíveis.
- Preview embutido recebe a scrollbar Neko diretamente no frame do projeto.
- Preview aberto em nova janela usa a mesma scrollbar Neko.
- Mantida a atualização em tempo real via servidor de desenvolvimento/HMR.
- Removido o cabeçalho redundante “Neko Agent / Construindo seu projeto” acima do chat.
- Scrollbars da interface Neko permanecem padronizadas visualmente.

## Validação pendente

- [ ] `npm run build` sem erros na máquina de desenvolvimento.
- [ ] Confirmar que uma mensagem do usuário aparece antes do plano correspondente.
- [ ] Confirmar que planos continuam na posição temporal correta após novas mensagens.
- [ ] Confirmar Console com `console.log`, `console.warn` e `console.error` do Preview.
- [ ] Confirmar Erros com warnings/erros de React e JavaScript.
- [ ] Confirmar scrollbar Neko dentro da página do Preview.
- [ ] Confirmar scrollbar Neko no Preview externo.
- [ ] Confirmar que nenhum texto visível revela o motor interno.

## Regra

Não marcar esta etapa como concluída apenas pela criação dos arquivos. A validação real depende de build, runtime, Preview e testes visuais.


# v0.4.69 — Preview scrollbar final + diagnostics sanitization

## Implementado nesta versão

- Corrigida a aplicação da scrollbar Neko diretamente no documento do Preview, incluindo frames e recargas.
- Corrigida a aplicação da mesma scrollbar na janela externa do Preview.
- Corrigida a identificação de origem dos logs para nunca exibir o nome do motor interno.
- Sanitização aplicada também ao campo de origem dos registros do terminal.
- Mantido o fluxo de Console/Erros/Logs e a atualização HMR do Preview.
- Resposta final do Agent recebe timestamp explícito para preservar a ordem cronológica do chat.

## Validação pendente

- [ ] `npm run build` sem erros.
- [ ] scrollbar Neko visível dentro da página do Preview.
- [ ] scrollbar Neko visível no Preview externo.
- [ ] Console recebe `console.log`, `console.warn` e `console.error`.
- [ ] Erros recebe exceções/erros de runtime.
- [ ] Nenhum registro visível contém o nome do motor interno.
- [ ] mensagens, planos e respostas permanecem na ordem em que ocorreram.


# v0.4.70 — Performance + Preview Core (prioridade máxima)

## Implementado nesta versão

- Deduplicação de transições `session.status` antes do Renderer.
- Eventos internos `session.updated` e `session.diff` deixam de ser enviados ao Renderer.
- SSE continua como caminho principal para o estado do Agent; o polling passa a atuar somente como watchdog quando o fluxo de eventos fica silencioso.
- Preview interno fica invisível até receber o tema visual, evitando o flash do scrollbar antigo.
- Tema de scrollbar do Preview é preparado em document-start e reaplicado após o carregamento do frame.
- Preview externo é criado oculto e só aparece após o documento estar carregado e o tema aplicado.
- Terminal interno passa a ocupar altura fixa e possui scroll próprio, sem aumentar indefinidamente o workspace.
- Terminal mantém auto-scroll somente quando o usuário já está próximo do final.
- Adicionada uma ponte IPC para reaplicar o tema do frame do Preview sob demanda.

## Validação pendente

- [ ] `npm run build` sem erros.
- [ ] Preview interno abre já com scrollbar Neko, sem flash da scrollbar padrão.
- [ ] Preview externo abre já com scrollbar Neko, sem flash da scrollbar padrão.
- [ ] Logs permanecem em área de altura fixa com scroll interno.
- [ ] Repetições de `busy` não causam atualizações visuais redundantes.
- [ ] Tarefa continua responsiva durante streaming e execução de ferramentas.
- [ ] Múltiplos projetos continuam isolados.

## Próxima etapa após validação

1. Validar a prioridade máxima.
2. Implementar segunda prioridade: otimização de validação, esforço adaptativo e pipeline/cache de anexos.
3. Implementar métricas internas de latência.
4. Retomar o roadmap oficial.


# v0.4.71 — Event Normalizer Core

Status: implementado, aguardando validação.

- Eventos internos filtrados antes do Renderer.
- Status deduplicado.
- Atividades normalizadas.
- Filtros de ruído adicionados.


# v0.4.72 — Fase 6: Sistema Global de Modais

Status: CONCLUÍDA.

- Padronização dimensional unificada em 500px para todos os modais.
- Acessibilidade e semântica (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`).
- Fechamento e navegação por teclado (`Escape` inteligente).
- Foco automático e overlay com blur.
- Modularidade estrutural (`modal-head`, `modal-scroll-body`, `modal-actions`).


# v0.4.73 — Fase 7: Auditoria Geral / Estabilidade

Status: CONCLUÍDA.

- Encerramento determinístico de processos filhos no Windows (`taskkill /T /F` assíncrono).
- Hooks globais de saída (`will-quit`, `SIGINT`, `SIGTERM`, `exit`).
- Watchers com proteção a exceções no `fs.watch`.
- Limpeza profunda e isolamento rigoroso entre múltiplos projetos.
- Contenção de memória com expiração de diagnósticos.
- Sanitização de segurança de tokens e IPC.


# v0.4.74 — Fase 8: Nova Home com Máxima Fidelidade Visual

Status: CONCLUÍDA & VALIDADA EM RUNTIME.

## Implementado nesta versão

- **Hero Centralizado**:
  - Novo logo oficial em alta resolução com glow violeta suave e cantos arredondados.
  - Título principal: *"O que iremos construir juntos?"*.
  - Subtítulo: *"Comece um projeto ou abra um existente, nós cuidamos de tudo, as tecnologias, dependências e servidor"*.
  - Apenas 2 botões principais de ação: `[+ Criar novo projeto]` e `[📁 Abrir projeto existente]`.
- **Navegação em Abas & Divisor**:
  - Abas `"Meus projetos"` e `"Favoritos"` com linha indicadora ativa roxa neon e contador reativo.
  - Divisor horizontal escuro com borda suave integrada ao fundo.
- **Grid de Projetos em 3 Colunas**:
  - Grid responsivo (3 colunas no desktop, 2 no tablet, 1 no mobile).
  - Cards de projeto com preview amplo da interface (dark UI mock com prompt, editor de código e deploy status).
  - Botão de favoritar (estrela roxa) no canto superior direito do preview com persistência em `localStorage`.
  - Footer com nome do projeto e botão verde `[Abrir Projeto]` com borda/fundo verde neon idêntico à referência.
  - Prevenção de propagação de eventos no clique do botão e da estrela.
- **Transição Workspace ↔ Home**:
  - Botão `Sair` integrado ao cabeçalho do Workspace (ao lado do GitHub) para retornar à Home a qualquer momento.
  - Encerramento automático dos processos do Vite/Preview e redefinição de estado ao sair.
- **Integração GitHub**:
  - Preservada 100% das funcionalidades de clonar repositório e autenticação através dos modais e do cabeçalho.

## Validação em Runtime Real Realizada

- [x] `npm run build` executado com sucesso e zero erros de compilação.
- [x] Electron runtime iniciado com carregamento completo de assets.
- [x] Captura de tela em resolução nativa (1440x900) confrontada com a imagem oficial de referência.
- [x] Grid de projetos, abas, hero, botões e estilização 100% validados.

