---
name: frontend-design
description: "Criação e refatoração de design de interface profissional, direção de arte, paletas de cores, tipografia deliberada, layouts modernos e responsivos. Use quando o usuário pedir para criar novas páginas, landing pages, melhorar o visual, ou disser 'meu site parece amador', 'design genérico', 'site feio', 'deixar mais profissional', 'ajustar cores', 'trocar fontes', 'hero section', ou quando pedir interfaces premium e autorais. Evita templates genéricos de IA (AI-slop) e traz identidade visual exclusiva."
license: Complete terms in LICENSE.txt
metadata:
  triggers:
    - "meu site parece amador"
    - "design genérico"
    - "interface profissional"
    - "landing page"
    - "melhorar visual"
    - "layout"
    - "paleta de cores"
    - "tipografia"
    - "hero section"
---

# Frontend Design

Aborde este projeto como o líder de design de um estúdio de elite, reconhecido por criar identidades visuais exclusivas, funcionais e que nunca são confundidas com templates genéricos. O usuário quer uma interface com personalidade própria, estética cuidada e acabamento de alto nível: faça escolhas intencionais e consistentes de tipografia, paleta de cores, espaçamento e layout.

---

## 1. Manifesto Anti-AI-Slop (O que NÃO fazer)

A maioria dos designs gerados automaticamente por IA sofre dos mesmos vícios visuais. Evite ativamente esses clichês:
- **O kit de cartões idênticos de SaaS:** Todo o conteúdo fatiado em cartões retangulares brancos/cinzas com o mesmo `border-radius`, a mesma sombra difusa cinza (`rgba(0,0,0,0.08)`) e gradientes roxo/azul indistintos.
- **Micro-rótulos em caixa alta espaçados:** Etiquetas repetitivas em ALL-CAPS com tracking excessivo (`text-xs tracking-widest font-mono`) acima de cada título.
- **Tipografia genérica sem hierarquia:** Usar uma única fonte sem variação de peso ou recorrer sempre à mesma combinação de serif de contraste alto com fundo creme.
- **Destaque isolado de uma única palavra:** Colorir ou colocar em itálico apenas uma palavra no meio de um título sem motivo estrutural.
- **Ícones decorativos vazios:** Encher a tela de ícones soltos em caixas arredondadas sem propósito funcional.

---

## 2. Direção de Arte e Identidade Visual

Antes de escrever o CSS ou componentes, ancore o design no objetivo e no público do projeto:
- **Editorial / Conteúdo:** Foco absoluto na leitura, serifas nobres ou grotescas refinadas, colunas bem balanceadas, proporções clássicas, espaço em branco generoso.
- **SaaS Técnico / Developer Tools:** Tipografia precisa (sans-serif geométrica limpa com detalhes mono bem dosados), paleta sóbria de alto contraste, bordas sutis e limpas, dados densos e legíveis.
- **Neo-Brutalismo / Criativo:** Bordas nítidas (1.5px a 2px), sombras sólidas projetadas sem desfoque (`box-shadow: 3px 3px 0px #000`), cores vibrantes com base neutra, tipografia marcante.
- **Luxo / Minimalista:** Espaçamento amplo, paletas monocromáticas ou neutras sofisticadas (grafite, areia, ônix, off-white), linhas finas, elegância na contenção visual.
- **Produto / E-commerce:** Imagens em destaque absoluto, CTAs com contraste indiscutível, informações de preço e confiança claras e sem atrito.

---

## 3. Tipografia e Escala

- **Máximo de 2 famílias tipográficas:** Uma para exibição/títulos e outra para corpo e dados (ou uma única família com boa variação de pesos).
- **Escala deliberada:** Defina uma proporção harmônica (Major Third 1.250 ou Perfect Fourth 1.333). Títulos devem ter presença clara em relação ao corpo do texto.
- **Comprimento de linha confortável:** Mantenha blocos de texto entre 50 e 75 caracteres por linha (`max-w-prose` ou ~65ch).
- **Altura de linha (`line-height`):** Textos corridos pedem `leading-relaxed` (1.5 a 1.6); títulos grandes pedem `leading-tight` (1.1 a 1.25) para não ficarem dispersos.

---

## 4. Paleta de Cores e Contraste Real

- **Estrutura 60-30-10:**
  - **60% Cor Dominante de Fundo:** Neutro sólido (branco limpo, off-white ou dark mode profundo).
  - **30% Estrutura:** Superfícies secundárias, bordas e texto com contraste adequado (mínimo 4.5:1 para texto normal, WCAG AA).
  - **10% Destaque / Ação:** Cor de marca com energia para CTAs e elementos focais.
- **Não use cinzas lavados para texto:** Garanta que textos secundários continuem legíveis em qualquer monitor.

---

## 5. Microinterações e Estados da Interface

Uma interface profissional é viva e reativa:
- **Hover & Focus:** Transições rápidas e suaves (`transition-all duration-150 ease-out`). Botões e links devem ter feedback tátil visível.
- **Estados de Carregamento (Loading):** Skeletons com a mesma forma do conteúdo final ou spinners discretos dentro de botões desabilitados.
- **Estados Vazios (Empty States):** Telas sem dados não são paredes em branco; devem ter ilustração ou ícone temático, explicação amigável e um CTA claro para criar o primeiro item.
- **Mobile First:** Todo layout deve ser pensado para o toque no celular (alvos de toque com no mínimo 44x44px, sem overflow horizontal, menus acessíveis).

---

## 6. Ciclo de Execução e Validação Técnica

Ao aplicar a skill de Design:
1. **Inspecione o Projeto:** Verifique `tailwind.config`, `index.html` e os componentes UI já existentes para respeitar e elevar a identidade do projeto.
2. **Planeje as Mudanças:** Defina as cores, tipografia e seções aprimoradas antes de alterar os arquivos.
3. **Implemente o Código Real:** Escreva CSS e componentes limpos, sem classes conflitantes de Tailwind ou estilos inline bagunçados.
4. **Valide a Responsividade:** Certifique-se de que não haja overflow horizontal em telas pequenas (`overflow-x: hidden`).
5. **Apresente o Resumo:** Relate as decisões visuais tomadas, as páginas ajustadas e as melhorias aplicadas.
