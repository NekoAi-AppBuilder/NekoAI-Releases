---
name: react-best-practices
description: "Otimização profunda de performance e arquitetura React (Vercel Engineering): eliminação de waterfalls assíncronos, re-renders excessivos, code-splitting, memoização cirúrgica (useMemo, useCallback, memo), derived state, list rendering e otimização de bundle. Use quando o usuário disser 'site lento', 'react travando', 'renderizando muitas vezes', 'componente pesado', 'otimizar react', 're-renders desnecessários', 'input lento ao digitar', 'otimizar carregamento' ou 'react performance guidelines'."
license: MIT
metadata:
  author: vercel
  version: "1.1.0"
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: 22 of the 70 rules were removed — the ones that only apply to Next.js, React Server Components or SWR, that need the newest React APIs or an extra npm package, or that do not pay off in a Vite project. The 48 that remain are unchanged. License: see LICENSE.txt in this folder. -->

# Vercel React Best Practices

Comprehensive performance optimization guide for React applications, maintained by Vercel. Contains 48 rules across 7 categories, prioritized by impact to guide automated refactoring and code generation.

## When to Apply

Reference these guidelines when:
- Writing new React components or pages
- Implementing data fetching
- Reviewing code for performance issues
- Refactoring existing React code
- Optimizing bundle size or load times

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | `async-` |
| 2 | Bundle Size Optimization | CRITICAL | `bundle-` |
| 4 | Client-Side Data Fetching | MEDIUM-HIGH | `client-` |
| 5 | Re-render Optimization | MEDIUM | `rerender-` |
| 6 | Rendering Performance | MEDIUM | `rendering-` |
| 7 | JavaScript Performance | LOW-MEDIUM | `js-` |
| 8 | Advanced Patterns | LOW | `advanced-` |

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)

- `async-cheap-condition-before-await` - Check cheap sync conditions before awaiting flags or remote values
- `async-defer-await` - Move await into branches where actually used
- `async-parallel` - Use Promise.all() for independent operations

### 2. Bundle Size Optimization (CRITICAL)

- `bundle-analyzable-paths` - Prefer statically analyzable import and file-system paths to avoid broad bundles and traces
- `bundle-conditional` - Load modules only when feature is activated
- `bundle-preload` - Preload on hover/focus for perceived speed

### 4. Client-Side Data Fetching (MEDIUM-HIGH)

- `client-passive-event-listeners` - Use passive listeners for scroll
- `client-localstorage-schema` - Version and minimize localStorage data

### 5. Re-render Optimization (MEDIUM)

- `rerender-defer-reads` - Don't subscribe to state only used in callbacks
- `rerender-memo` - Extract expensive work into memoized components
- `rerender-memo-with-default-value` - Hoist default non-primitive props
- `rerender-dependencies` - Use primitive dependencies in effects
- `rerender-derived-state` - Subscribe to derived booleans, not raw values
- `rerender-derived-state-no-effect` - Derive state during render, not effects
- `rerender-functional-setstate` - Use functional setState for stable callbacks
- `rerender-lazy-state-init` - Pass function to useState for expensive values
- `rerender-simple-expression-in-memo` - Avoid memo for simple primitives
- `rerender-split-combined-hooks` - Split hooks with independent dependencies
- `rerender-move-effect-to-event` - Put interaction logic in event handlers
- `rerender-transitions` - Use startTransition for non-urgent updates
- `rerender-use-deferred-value` - Defer expensive renders to keep input responsive
- `rerender-use-ref-transient-values` - Use refs for transient frequent values
- `rerender-no-inline-components` - Don't define components inside components

### 6. Rendering Performance (MEDIUM)

- `rendering-animate-svg-wrapper` - Animate div wrapper, not SVG element
- `rendering-content-visibility` - Use content-visibility for long lists
- `rendering-hoist-jsx` - Extract static JSX outside components
- `rendering-svg-precision` - Reduce SVG coordinate precision
- `rendering-hydration-no-flicker` - Use inline script for client-only data
- `rendering-hydration-suppress-warning` - Suppress expected mismatches
- `rendering-conditional-render` - Use ternary, not && for conditionals
- `rendering-usetransition-loading` - Prefer useTransition for loading state
- `rendering-script-defer-async` - Use defer or async on script tags

### 7. JavaScript Performance (LOW-MEDIUM)

- `js-batch-dom-css` - Group CSS changes via classes or cssText
- `js-index-maps` - Build Map for repeated lookups
- `js-cache-property-access` - Cache object properties in loops
- `js-cache-function-results` - Cache function results in module-level Map
- `js-cache-storage` - Cache localStorage/sessionStorage reads
- `js-combine-iterations` - Combine multiple filter/map into one loop
- `js-length-check-first` - Check array length before expensive comparison
- `js-early-exit` - Return early from functions
- `js-hoist-regexp` - Hoist RegExp creation outside loops
- `js-min-max-loop` - Use loop for min/max instead of sort
- `js-set-map-lookups` - Use Set/Map for O(1) lookups
- `js-tosorted-immutable` - Use toSorted() for immutability
- `js-flatmap-filter` - Use flatMap to map and filter in one pass
- `js-request-idle-callback` - Defer non-critical work to browser idle time

### 8. Advanced Patterns (LOW)

- `advanced-event-handler-refs` - Store event handlers in refs
- `advanced-init-once` - Initialize app once per app load

## Como Consultar as Regras

Quando identificar uma área de oportunidade (waterfalls, re-renders, bundle, data fetching), consulte os playbooks detalhados diretamente em seus caminhos no projeto:

```
.agents/skills/react-best-practices/rules/async-parallel.md
.agents/skills/react-best-practices/rules/rerender-memo.md
.agents/skills/react-best-practices/rules/rerender-derived-state-no-effect.md
.agents/skills/react-best-practices/rules/bundle-conditional.md
```

Cada playbook detalha:
- Causa raiz do problema de performance
- Exemplo anti-padrão (❌ Código incorreto)
- Exemplo otimizado (✅ Código correto)
- Impacto esperado e referências técnicas

---

## Ciclo de Execução de Engenharia

Ao otimizar qualquer componente ou fluxo React:

1. **Inspecionar:**
   - Analise os componentes envolvidos (`src/components/`, `src/pages/`, `src/hooks/`).
   - Identifique estados duplicados, hooks com dependências instáveis, `useEffect` usados para derivar estado (anti-padrão) e renderizações em loop.
   - Verifique chamadas assíncronas em cascata que poderiam ser paralelas (`Promise.all`).

2. **Planejar:**
   - Priorize por impacto (P1: Waterfalls/Async -> P2: Bundle -> P5: Re-renders -> P6: DOM/Rendering).
   - Defina exatamente quais componentes serão refatorados sem quebrar contratos de props ou hooks existentes.

3. **Implementar:**
   - Aplique as regras recomendadas: derive estado durante o render em vez de `useEffect`, use `useCallback` com dependências estáveis, extraia sub-árvores pesadas em componentes memoizados.
   - Para inputs com alta frequência de digitação, aplique `useDeferredValue` ou gerencie estado localmente.
   - Utilize `React.lazy` e `Suspense` em rotas ou modais pesados para code-splitting.

4. **Validar:**
   - Execute o build do projeto (`npm run build` ou `vite build`) para confirmar que não há erros de tipagem TypeScript ou imports quebrados.
   - Verifique que o comportamento funcional e reatividade da UI continuam idênticos.

5. **Reportar:**
   - Descreva as regras aplicadas, antes/depois da estrutura de componentes e os ganhos concretos de renderização e carregamento obtidos.
