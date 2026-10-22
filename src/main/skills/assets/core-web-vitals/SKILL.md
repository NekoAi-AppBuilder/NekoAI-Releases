---
name: core-web-vitals
description: "Otimização profunda de Core Web Vitals (LCP, INP, CLS, FID) e performance de carregamento: correção de layout shifts, imagens sem dimensões, render-blocking resources, preloads de fontes e hero images, lazy loading inteligente e otimização de thread principal. Use quando o usuário disser 'site demora pra abrir', 'layout pulando', 'página instável', 'PageSpeed baixo', 'nota ruim no Lighthouse', 'LCP alto', 'CLS ruim', 'otimizar carregamento' ou 'core web vitals'."
license: MIT
metadata:
  author: web-quality-skills
  version: "2.1.0"
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: the measurement workflow and tools, the console diagnostics, the Speculation Rules section and the Next.js/Vue examples were removed; the rest is unchanged. License: see LICENSE.txt in this folder. -->

# Core Web Vitals optimization

Targeted optimization for the three Core Web Vitals using field data to identify user impact and browser traces to diagnose causes.

## The three metrics

| Metric | Measures | Good | Needs work | Poor |
|--------|----------|------|------------|------|
| **LCP** | Loading | ≤ 2.5s | 2.5s – 4s | > 4s |
| **INP** | Interactivity | ≤ 200ms | 200ms – 500ms | > 500ms |
| **CLS** | Visual Stability | ≤ 0.1 | 0.1 – 0.25 | > 0.25 |

Google measures at the **75th percentile** — 75% of page visits must meet "Good" thresholds.

---

## LCP: Largest Contentful Paint

LCP measures when the largest visible content element renders. Usually this is:
- Hero image or video
- Large text block
- Background image
- `<svg>` element

### Common LCP issues

**1. Slow server response (TTFB > 800ms)**
```
Fix: CDN, caching, optimized backend, edge rendering
```

**2. Render-blocking resources**
```html
<!-- ❌ Blocks rendering -->
<link rel="stylesheet" href="/all-styles.css">

<!-- ✅ Critical CSS inlined, rest deferred -->
<style>/* Critical above-fold CSS */</style>
<link rel="preload" href="/styles.css" as="style" 
      onload="this.onload=null;this.rel='stylesheet'">
```

**3. Slow resource load times**
```html
<!-- ❌ LCP image is discovered only after a stylesheet loads -->
<div class="hero"></div>

<!-- ✅ Discoverable in initial HTML and prioritized -->
<link rel="preload" href="/hero.webp" as="image" fetchpriority="high">
<img src="/hero.webp" alt="Hero" fetchpriority="high">
```

Prefer a discoverable `<img>` with `fetchpriority="high"`. Add the preload only when the trace shows that the resource would otherwise be discovered late; duplicate or speculative preloads can compete for bandwidth.

### LCP optimization checklist

```markdown
- [ ] TTFB < 800ms (use CDN, edge caching)
- [ ] LCP resource is discoverable in initial HTML and prioritized; preload only if the trace shows late discovery
- [ ] LCP image optimized (WebP/AVIF, correct size)
- [ ] Critical CSS inlined (< 14KB)
- [ ] No render-blocking JavaScript in <head>
- [ ] Fonts don't block text rendering (font-display: swap)
- [ ] LCP element in initial HTML (not JS-rendered)
```

---

## INP: Interaction to Next Paint

INP measures responsiveness across clicks, taps, and key presses during a visit. Diagnose its input delay, processing time, and presentation delay separately; a slow interaction may involve main-thread contention before the handler, expensive application work, or delayed rendering after it.

When field INP is poor or a trace identifies a slow interaction, read [the INP reference](.agents/skills/core-web-vitals/references/INP.md) for trace interpretation, yielding patterns, third-party and rendering causes, a single-session observer, and first-party attribution.

---

## CLS: Cumulative Layout Shift

CLS measures unexpected layout shifts across a page visit. Use field attribution or a trace to identify the shifted node and the trigger; do not assume the visible victim caused the shift.

When field CLS is poor or a trace reports shifts, read [the CLS reference](.agents/skills/core-web-vitals/references/CLS.md) for reserved-space patterns, dynamic content, font and animation fixes, a debugging observer, and a verification checklist.

---

## Framework quick fixes

### React
```jsx
// LCP: Preload in head
<link rel="preload" href="/hero.webp" as="image" fetchpriority="high" />

// INP: Memoize and useTransition
const [isPending, startTransition] = useTransition();
startTransition(() => setExpensiveState(newValue));

// CLS: Always specify explicit dimensions or aspect-ratio on images and embeds
<img src="/hero.webp" width={800} height={400} className="w-full h-auto" alt="Hero" />
```

## References & Playbooks Técnicos

- [Otimização detalhada de LCP](.agents/skills/core-web-vitals/references/LCP.md) — carregamento prioritário, otimização de imagens hero e fontes
- [Otimização detalhada de INP](.agents/skills/core-web-vitals/references/INP.md) — desfragmentação de tarefas longas na thread principal e startTransition
- [Otimização detalhada de CLS](.agents/skills/core-web-vitals/references/CLS.md) — reserva de espaço com aspect-ratio, skeletons e font-display

---

## Ciclo de Execução de Engenharia

Ao otimizar métricas vitais da web (Core Web Vitals):

1. **Inspecionar:**
   - Analise `index.html` e os componentes de layout (`src/App.tsx`, `src/pages/`, etc.).
   - Procure por imagens sem largura/altura ou `aspect-ratio` (causa raiz de CLS).
   - Verifique fontes externas carregadas sem `font-display: swap` ou sem `preconnect`.
   - Identifique imagens hero acima da dobra com `loading="lazy"` (anti-padrão que atrasa o LCP).

2. **Planejar:**
   - Mapeie o maior elemento de conteúdo visível (LCP), os gatilhos de layout shift (CLS) e os bloqueios de thread principal (INP).
   - Defina as correções no código sem alterar a estética final da interface.

3. **Implementar:**
   - Adicione dimensões explícitas (`width` e `height`) e classes CSS com `aspect-ratio` em imagens, vídeos e iframes.
   - Garanta que a imagem de Hero principal tenha `fetchpriority="high"` e **nunca** tenha `loading="lazy"`.
   - Aplique `loading="lazy"` e `decoding="async"` apenas em imagens abaixo da dobra.
   - Adicione skeletons com a mesma altura para elementos carregados assincronamente.

4. **Validar:**
   - Execute o build do projeto (`npm run build` ou `vite build`) para assegurar que não haja quebra de compilação.
   - Verifique visualmente que nenhum elemento salta ou muda de posição durante o carregamento de imagens ou dados assíncronos.

5. **Reportar:**
   - Descreva os arquivos corrigidos, as otimizações de LCP, INP e CLS aplicadas e os ganhos esperados na estabilidade visual e velocidade.
