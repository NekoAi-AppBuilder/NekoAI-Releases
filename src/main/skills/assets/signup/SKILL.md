---
name: signup
description: "Otimização e implementação de fluxos de cadastro (signup), login, autenticação social (OAuth Google/GitHub), ativação de conta e onboarding sem fricção. Especialmente adaptado para Supabase Auth e Lovable Auth. Use quando o usuário disser 'cadastro complicado', 'login confuso', 'ninguém termina o cadastro', 'melhorar tela de login', 'recuperação de senha', 'adicionar login social', 'simplificar cadastro', 'signup dropoff' ou 'auth flow'."
metadata:
  version: 2.1.0
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: the steps that ask the user questions, the A/B-test ideas, the measurement section and the pointers to sibling skills were removed; the rest is unchanged. License: see LICENSE.txt in this folder. -->

# Signup Flow CRO

You are an expert in optimizing signup and registration flows. Your goal is to reduce friction, increase completion rates, and set users up for successful activation.

## Initial Assessment

Before providing recommendations, understand:

1. **Flow Type**
   - Free trial signup
   - Freemium account creation
   - Paid account creation
   - Waitlist/early access signup
   - B2B vs B2C

2. **Current State**
   - How many steps/screens?
   - What fields are required?
   - What's the current completion rate?
   - Where do users drop off?

3. **Business Constraints**
   - What data is genuinely needed at signup?
   - Are there compliance requirements?
   - What happens immediately after signup?

---

## Core Principles

### 1. Minimize Required Fields
Every field reduces conversion. For each field, ask:
- Do we absolutely need this before they can use the product?
- Can we collect this later through progressive profiling?
- Can we infer this from other data?

**Typical field priority:**
- Essential: Email (or phone), Password
- Often needed: Name
- Usually deferrable: Company, Role, Team size, Phone, Address

### 2. Show Value Before Asking for Commitment
- What can you show/give before requiring signup?
- Can they experience the product before creating an account?
- Reverse the order: value first, signup second

### 3. Reduce Perceived Effort
- Show progress if multi-step
- Group related fields
- Use smart defaults
- Pre-fill when possible

### 4. Remove Uncertainty
- Clear expectations ("Takes 30 seconds")
- Show what happens after signup
- No surprises (hidden requirements, unexpected steps)

---

## Field-by-Field Optimization

### Email Field
- Single field (no email confirmation field)
- Inline validation for format
- Check for common typos (gmial.com → gmail.com)
- Clear error messages

### Password Field
- Show password toggle (eye icon)
- Show requirements upfront, not after failure
- Consider passphrase hints for strength
- Update requirement indicators in real-time

**Better password UX:**
- Allow paste (don't disable)
- Show strength meter instead of rigid rules
- Consider passwordless options

### Name Field
- Single "Full name" field vs. First/Last split (test this)
- Only require if immediately used (personalization)
- Consider making optional

### Social Auth Options
- Place prominently (often higher conversion than email)
- Show most relevant options for your audience
  - B2C: Google, Apple, Facebook
  - B2B: Google, Microsoft, SSO
- Clear visual separation from email signup
- Consider "Sign up with Google" as primary

### Phone Number
- Defer unless essential (SMS verification, calling leads)
- If required, explain why
- Use proper input type with country code handling
- Format as they type

### Company/Organization
- Defer if possible
- Auto-suggest as they type
- Infer from email domain when possible

### Use Case / Role Questions
- Defer to onboarding if possible
- If needed at signup, keep to one question
- Use progressive disclosure (don't show all options at once)

---

## Single-Step vs. Multi-Step

### Single-Step Works When:
- 3 or fewer fields
- Simple B2C products
- High-intent visitors (from ads, waitlist)

### Multi-Step Works When:
- More than 3-4 fields needed
- Complex B2B products needing segmentation
- You need to collect different types of info

### Multi-Step Best Practices
- Show progress indicator
- Lead with easy questions (name, email)
- Put harder questions later (after psychological commitment)
- Each step should feel completable in seconds
- Allow back navigation
- Save progress (don't lose data on refresh)

**Progressive commitment pattern:**
1. Email only (lowest barrier)
2. Password + name
3. Customization questions (optional)

---

## Trust and Friction Reduction

### At the Form Level
- "No credit card required" (if true)
- "Free forever" or "14-day free trial"
- Privacy note: "We'll never share your email"
- Security badges if relevant
- Testimonial near signup form

### Error Handling
- Inline validation (not just on submit)
- Specific error messages ("Email already registered" + recovery path)
- Don't clear the form on error
- Focus on the problem field

### Microcopy
- Placeholder text: Use for examples, not labels
- Labels: Keep visible (not just placeholders) — placeholders disappear when typing, leaving users unsure what they're filling in
- Help text: Only when needed, placed close to field

---

## Mobile Signup Optimization

- Larger touch targets (44px+ height)
- Appropriate keyboard types (email, tel, etc.)
- Autofill support
- Reduce typing (social auth, pre-fill)
- Single column layout
- Sticky CTA button
- Test with actual devices

---

## Post-Submit Experience

### Success State
- Clear confirmation
- Immediate next step
- If email verification required:
  - Explain what to do
  - Easy resend option
  - Check spam reminder
  - Option to change email if wrong

### Verification Flows
- Consider delaying verification until necessary
- Magic link as alternative to password
- Let users explore while awaiting verification
- Clear re-engagement if verification stalls

---

## Output Format

### Audit Findings
For each issue found:
- **Issue**: What's wrong
- **Impact**: Why it matters (with estimated impact if possible)
- **Fix**: Specific recommendation
- **Priority**: High/Medium/Low

### Recommended Changes
Organized by:
1. Quick wins (same-day fixes)
2. High-impact changes (week-level effort)
3. Test hypotheses (things to A/B test)

### Form Redesign (if requested)
- Recommended field set with rationale
- Field order
- Copy for labels, placeholders, buttons, errors
- Visual layout suggestions

---

## Common Signup Flow Patterns

### B2B SaaS Trial
1. Email + Password (or Google auth)
2. Name + Company (optional: role)
3. → Onboarding flow

### B2C App
1. Google/Apple auth OR Email
2. → Product experience
3. Profile completion later

### Waitlist/Early Access
1. Email only
2. Optional: Role/use case question
3. → Waitlist confirmation

### E-commerce Account
1. Guest checkout as default
2. Account creation optional post-purchase
3. OR Social auth with single click

---

## Boas Práticas com Supabase Auth / Lovable Auth

Quando o projeto utiliza Supabase Auth:
- **Tratamento de Erros Humanizado:** Nunca exiba mensagens cruas em inglês como `Invalid login credentials` ou `User already registered`. Mapeie para: *"E-mail ou senha incorretos"* ou *"Este e-mail já possui uma conta. Deseja fazer login?"*.
- **OAuth Social Redirects:** Configure sempre a URL de redirecionamento (`redirectTo`) usando `window.location.origin` para funcionar corretamente em ambientes locais (localhost) e de produção/staging sem hardcode.
- **Feedback de Carregamento:** Desabilite o botão de envio e adicione spinner durante a requisição `supabase.auth.signUp()` ou `signInWithPassword()`.
- **Validação Antecipada:** Valide formato de e-mail e requisitos mínimos de senha antes do submit para evitar round-trips com erro de API.

---

## Ciclo de Execução de Engenharia

Ao implementar ou otimizar o fluxo de cadastro e autenticação:

1. **Inspecionar:**
   - Analise os componentes de autenticação (`src/pages/Auth.tsx`, `src/components/auth/`, etc.).
   - Verifique como o estado de sessão é mantido (ex: `onAuthStateChange`, contexts de autenticação).
   - Identifique atritos: campos em excesso, ausência de botão para exibir senha, ausência de link claro de recuperação de senha.

2. **Planejar:**
   - Defina a experiência: login/cadastro em tabs ou páginas separadas, suporte a OAuth se configurado, mensagens de validação inline.
   - Garanta que após o cadastro o usuário seja redirecionado imediatamente para o dashboard ou onboarding sem ficar preso em tela em branco.

3. **Implementar:**
   - Refatore o formulário de cadastro no código com labels acessíveis, `autocomplete="email"` / `autocomplete="new-password"`.
   - Adicione toggle de visualização de senha ("mostrar/ocultar senha").
   - Trate erros de forma amigável com toasts ou avisos no topo do formulário.

4. **Validar:**
   - Execute o build do projeto (`npm run build` ou `vite build`) para confirmar integridade de TypeScript e JSX.
   - Verifique que os hooks de auth não causam re-render infinito após o redirecionamento.

5. **Reportar:**
   - Descreva as melhorias no fluxo, os campos otimizados e as proteções de UX e segurança adicionadas.
