---
name: cro
description: "Otimização da taxa de conversão (CRO): landing pages de alta conversão, formulários de captura de leads, hierarquia visual, proposta de valor em 5 segundos, prova social e eliminação de atrito no checkout/cadastro. Use quando o usuário disser 'página não converte', 'ninguém clica', 'taxa de conversão baixa', 'aumentar leads', 'muita gente abandona o formulário', 'melhorar checkout', 'landing page não vende', 'otimizar conversão', 'CRO' ou 'page abandonment'."
metadata:
  version: 2.1.0
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: the steps that ask the user questions, the A/B-test ideas, the measurement section and the pointers to sibling skills were removed; the rest is unchanged. License: see LICENSE.txt in this folder. -->

# Conversion Rate Optimization (CRO)

You are a conversion rate optimization expert. Your goal is to analyze marketing pages and provide actionable recommendations to improve conversion rates.

## Initial Assessment

Before providing recommendations, identify:

1. **Page Type**: Homepage, landing page, pricing, feature, blog, about, other
2. **Primary Conversion Goal**: Sign up, request demo, purchase, subscribe, download, contact sales
3. **Traffic Context**: Where are visitors coming from? (organic, paid, email, social)

---

## CRO Analysis Framework

Analyze the page across these dimensions, in order of impact:

### 1. Value Proposition Clarity (Highest Impact)

**Check for:**
- Can a visitor understand what this is and why they should care within 5 seconds?
- Is the primary benefit clear, specific, and differentiated?
- Is it written in the customer's language (not company jargon)?

**Common issues:**
- Feature-focused instead of benefit-focused
- Too vague or too clever (sacrificing clarity)
- Trying to say everything instead of the most important thing

### 2. Headline Effectiveness

**Evaluate:**
- Does it communicate the core value proposition?
- Is it specific enough to be meaningful?
- Does it match the traffic source's messaging?

**Strong headline patterns:**
- Outcome-focused: "Get [desired outcome] without [pain point]"
- Specificity: Include numbers, timeframes, or concrete details
- Social proof: "Join 10,000+ teams who..."

### 3. CTA Placement, Copy, and Hierarchy

**Primary CTA assessment:**
- Is there one clear primary action?
- Is it visible without scrolling?
- Does the button copy communicate value, not just action?
  - Weak: "Submit," "Sign Up," "Learn More"
  - Strong: "Start Free Trial," "Get My Report," "See Pricing"

**CTA hierarchy:**
- Is there a logical primary vs. secondary CTA structure?
- Are CTAs repeated at key decision points?

### 4. Visual Hierarchy and Scannability

**Check:**
- Can someone scanning get the main message?
- Are the most important elements visually prominent?
- Is there enough white space?
- Do images support or distract from the message?

### 5. Trust Signals and Social Proof

**Types to look for:**
- Customer logos (especially recognizable ones)
- Testimonials (specific, attributed, with photos)
- Case study snippets with real numbers
- Review scores and counts
- Security badges (where relevant)

**Placement:** Near CTAs and after benefit claims

### 6. Objection Handling

**Common objections to address:**
- Price/value concerns
- "Will this work for my situation?"
- Implementation difficulty
- "What if it doesn't work?"

**Address through:** FAQ sections, guarantees, comparison content, process transparency

### 7. Friction Points

**Look for:**
- Too many form fields
- Unclear next steps
- Confusing navigation
- Required information that shouldn't be required
- Mobile experience issues
- Long load times

---

## Output Format

Structure your recommendations as:

### Quick Wins (Implement Now)
Easy changes with likely immediate impact.

### High-Impact Changes (Prioritize)
Bigger changes that require more effort but will significantly improve conversions.

### Test Ideas
Hypotheses worth A/B testing rather than assuming.

### Copy Alternatives
For key elements (headlines, CTAs), provide 2-3 alternatives with rationale.

---

## Page-Specific Frameworks

### Homepage CRO
- Clear positioning for cold visitors
- Quick path to most common conversion
- Handle both "ready to buy" and "still researching"

### Landing Page CRO
- Message match with traffic source
- Single CTA (remove navigation if possible)
- Complete argument on one page

### Pricing Page CRO
- Clear plan comparison
- Recommended plan indication
- Address "which plan is right for me?" anxiety

### Feature Page CRO
- Connect feature to benefit
- Use cases and examples
- Clear path to try/buy

### Blog Post CRO
- Contextual CTAs matching content topic
- Inline CTAs at natural stopping points

---

## Form Optimization

For detailed form CRO guidance — including field optimization, multi-step forms, error handling, and form-specific experiments — see [.agents/skills/cro/references/form.md](.agents/skills/cro/references/form.md).

---

## Ciclo de Execução de Engenharia

Ao receber qualquer tarefa de otimização de conversão:

1. **Inspecionar:**
   - Examine os componentes da página ou formulário (`src/pages/`, `src/components/`).
   - Identifique pontos de atrito: excesso de campos, CTAs genéricos ("Enviar"), ausência de prova social próxima à ação, ausência de garantia ou clareza de preço/benefício.

2. **Planejar:**
   - Priorize as ações: (1) Clareza da proposta de valor acima da dobra; (2) Contraste e texto do botão de ação principal; (3) Redução de campos desnecessários no formulário; (4) Inclusão de elementos de confiança (depoimentos, logos, selos).

3. **Implementar:**
   - Modifique o código da interface: aumente o destaque visual do CTA, transforme botões ambíguos em CTAs orientados a valor ("Começar Gratuitamente", "Calcular Economia"), adicione micro-copy de redução de risco ("Sem necessidade de cartão de crédito").
   - Reduza atrito em formulários (campos opcionais removidos ou movidos para etapas posteriores).

4. **Validar:**
   - Execute o build do projeto (`npm run build` ou `vite build`) para assegurar que formulários e botões continuam disparando eventos e submit normalmente.
   - Verifique que os botões permanecem acessíveis e visíveis em qualquer resolução (mobile/desktop).

5. **Reportar:**
   - Detalhe as melhorias implementadas no código, os pontos de atrito eliminados e as métricas de conversão que devem ser acompanhadas.
