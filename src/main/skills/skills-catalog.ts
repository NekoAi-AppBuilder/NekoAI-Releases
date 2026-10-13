export interface SkillUsageConfig {
  rotulo: string;
  pedido: string;
  prompt: string;
}

export interface SkillDefinition {
  id: string;
  nome: string;
  grupo: "aparencia" | "crescimento" | "tecnico";
  resumo: string;
  quando: string;
  nota: string | null;
  arquivos: string[];
  usar: SkillUsageConfig;
}

export interface SkillCategory {
  id: string;
  nome: string;
}

export interface SkillStatusInfo {
  id: string;
  nome: string;
  grupo: "aparencia" | "crescimento" | "tecnico";
  resumo: string;
  quando: string;
  nota: string | null;
  arquivosCount: number;
  relativePath: string;
  installed: boolean;
  incomplete?: boolean;
  missingFiles?: string[];
  usar: SkillUsageConfig;
}

export interface SkillsProjectState {
  projectPath: string | null;
  installedCount: number;
  totalCount: number;
  skills: SkillStatusInfo[];
}

export const PASTA_DAS_SKILLS = ".agents/skills/";

export const SKILL_CATEGORIES: SkillCategory[] = [
  { id: "todos", nome: "Todos" },
  { id: "aparencia", nome: "Aparência" },
  { id: "crescimento", nome: "Atrair e converter" },
  { id: "tecnico", nome: "Qualidade técnica" }
];

export const REGRAS_DE_REACT = [
  "advanced-event-handler-refs", "advanced-init-once",
  "async-cheap-condition-before-await", "async-defer-await", "async-parallel",
  "bundle-analyzable-paths", "bundle-conditional", "bundle-preload",
  "client-localstorage-schema", "client-passive-event-listeners",
  "js-batch-dom-css", "js-cache-function-results", "js-cache-property-access", "js-cache-storage",
  "js-combine-iterations", "js-early-exit", "js-flatmap-filter", "js-hoist-regexp", "js-index-maps",
  "js-length-check-first", "js-min-max-loop", "js-request-idle-callback", "js-set-map-lookups",
  "js-tosorted-immutable",
  "rendering-animate-svg-wrapper", "rendering-conditional-render", "rendering-content-visibility",
  "rendering-hoist-jsx", "rendering-hydration-no-flicker", "rendering-hydration-suppress-warning",
  "rendering-script-defer-async", "rendering-svg-precision", "rendering-usetransition-loading",
  "rerender-defer-reads", "rerender-dependencies", "rerender-derived-state-no-effect",
  "rerender-derived-state", "rerender-functional-setstate", "rerender-lazy-state-init",
  "rerender-memo-with-default-value", "rerender-memo", "rerender-move-effect-to-event",
  "rerender-no-inline-components", "rerender-simple-expression-in-memo", "rerender-split-combined-hooks",
  "rerender-transitions", "rerender-use-deferred-value", "rerender-use-ref-transient-values"
];

const comoAplicar = (id: string, limite: number) =>
  `Leia primeiro "${PASTA_DAS_SKILLS}${id}/SKILL.md" e siga o que ela diz. Corrija de verdade o que encontrar — não devolva só uma lista. Mexa em no máximo ${limite} arquivos: comece pelo que mais importa e, se sobrar, diga no resumo o que ficou para um próximo pedido. Não mude o que funciona nem o que não tem a ver com o tema. No resumo, em linguagem simples, diga o que foi corrigido, em quais páginas, e o que depende do usuário.`;

export const SKILLS_CATALOG: SkillDefinition[] = [
  {
    id: "frontend-design",
    nome: "Design",
    grupo: "aparencia",
    resumo: "Visual com identidade própria: tipografia, cores e layout pensados para o seu negócio, sem cara de site genérico.",
    quando: "building a new page or section, or redesigning an existing one; requests to make the UI look better, more professional or less generic (typography, palette, layout, copy).",
    nota: "Use it for new screens and for requests about the look. For a small change inside an existing screen, keep the project's current theme tokens, fonts and components — do not restyle what was not asked. You cannot take screenshots or ask the client to confirm: decide, and state the direction you took in the summary.",
    arquivos: ["SKILL.md", "LICENSE.txt"],
    usar: {
      rotulo: "Melhorar o visual da página inicial",
      pedido: "🎨 Skill Design: melhorar o visual da página inicial",
      prompt: `Aplique a skill de design na PÁGINA INICIAL deste projeto. ${comoAplicar("frontend-design", 8)} Mantenha o conteúdo, as seções, os links e tudo o que funciona hoje; melhore tipografia, cores, espaçamento e hierarquia visual seguindo a skill. Se o projeto já tem cores de marca evidentes, parta delas. Só a página inicial (e os estilos globais que ela precisar) — as outras páginas ficam como estão.`
    }
  },
  {
    id: "seo",
    nome: "SEO",
    grupo: "crescimento",
    resumo: "Para o site aparecer no Google: títulos e descrições por página, prévia ao compartilhar o link, sitemap, robots e dados estruturados.",
    quando: "SEO work: page titles and meta descriptions, Open Graph / link previews, canonical URLs, robots.txt, sitemap.xml, structured data (JSON-LD), heading structure, image alt text; \"appear on Google\".",
    nota: null,
    arquivos: ["SKILL.md", "LICENSE.txt", "references/STRUCTURED-DATA.md"],
    usar: {
      rotulo: "Revisar o SEO do projeto",
      pedido: "🔎 Skill SEO: revisar e corrigir o SEO do projeto",
      prompt: `Aplique a skill de SEO neste projeto. ${comoAplicar("seo", 12)} Siga a ordem do checklist da skill: título e descrição únicos em cada página, idioma do documento, um título principal claro por página, prévia de compartilhamento (Open Graph), URL canônica, robots.txt, sitemap.xml, texto alternativo das imagens e dados estruturados onde fizer sentido. Não mude o visual nem o texto que o visitante lê além do necessário. Se o endereço real do site não aparecer no projeto, use um marcador óbvio e avise no resumo onde trocar.`
    }
  },
  {
    id: "supabase-security",
    nome: "Segurança",
    grupo: "tecnico",
    resumo: "Protege os dados do seu app: quem pode ver e editar cada informação, login, chaves e arquivos — o checklist oficial do Supabase.",
    quando: "anything touching login/auth, RLS policies, who can see or edit which data, storage access or API keys in the client; \"data does not show up\" or \"everyone can see everything\"; a security review.",
    nota: "Lovable Cloud is Supabase. Look at the real state before changing anything: with a database tool available, query pg_policies and pg_class.relrowsecurity; otherwise read supabase/migrations and the generated types. Database changes go through the database tool this project gives you. Identify the user with (select auth.uid()). In the frontend, any VITE_ variable and anything under src/ is sent to the browser.",
    arquivos: ["SKILL.md", "LICENSE.txt", "references/security-rls-performance.md"],
    usar: {
      rotulo: "Revisar a segurança do projeto",
      pedido: "🛡️ Skill Segurança: revisar e corrigir a segurança do projeto",
      prompt: `Aplique a skill de segurança neste projeto. ${comoAplicar("supabase-security", 10)} Percorra o checklist da skill: tabelas sem proteção de acesso por linha, regras que deixam um usuário ver ou alterar dados de outro, chaves secretas no código do navegador, funções e views que ignoram as regras, e acesso aos arquivos enviados. Antes de mudar, confira o estado real do banco com as ferramentas que você tiver.`
    }
  },
  {
    id: "react-best-practices",
    nome: "Performance",
    grupo: "tecnico",
    resumo: "Deixa o app mais rápido: menos travadas, telas que carregam antes e listas pesadas sem engasgar — 48 regras da engenharia da Vercel.",
    quando: "performance: slow or laggy screens, unnecessary re-renders, heavy lists, slow data loading, bundle size; a performance review of React code.",
    nota: "This project is NOT Next.js: ignore anything about next/*, Server Components or Server Actions that a rule may still mention. Check the React version in package.json before using an API newer than it. Rule files are at rules/<rule-name>.md — read only the ones you will apply. Apply a rule only where the code really has that problem; no blanket refactors.",
    arquivos: ["SKILL.md", "LICENSE.txt", ...REGRAS_DE_REACT.map(r => `rules/${r}.md`)],
    usar: {
      rotulo: "Revisar a performance do projeto",
      pedido: "⚡ Skill Performance: revisar e melhorar a performance do projeto",
      prompt: `Aplique a skill de performance neste projeto. ${comoAplicar("react-best-practices", 10)} Procure primeiro os problemas das categorias de maior impacto da skill nas páginas principais. Leia o arquivo da regra antes de aplicá-la. O comportamento e o visual do app têm de continuar exatamente iguais.`
    }
  },
  {
    id: "web-design-guidelines",
    nome: "Acessibilidade",
    grupo: "aparencia",
    resumo: "Revisão de acessibilidade e acabamento da interface: rótulos, teclado e foco, formulários, toque no celular e modo escuro.",
    quando: "accessibility and UI quality review: labels, keyboard and focus, forms, hover/active states, animation, touch, dark-mode details, long or empty content; \"review my UI\", \"check accessibility\".",
    nota: "The skill describes a review that outputs findings; in Build mode, fix them and report in plain words instead of printing the file:line list. UI text here is usually Brazilian Portuguese: keep sentence case and the project's wording.",
    arquivos: ["SKILL.md", "LICENSE.txt"],
    usar: {
      rotulo: "Revisar a acessibilidade e a interface",
      pedido: "♿ Skill Acessibilidade: revisar e corrigir a interface do projeto",
      prompt: `Aplique a skill de acessibilidade e qualidade de interface neste projeto. ${comoAplicar("web-design-guidelines", 12)} Revise as páginas e os componentes principais contra as regras da skill, começando pelos itens da lista de antipadrões e pelos de acessibilidade, foco e formulários.`
    }
  },
  {
    id: "copywriting",
    nome: "Textos",
    grupo: "crescimento",
    resumo: "Títulos, chamadas e textos que explicam o que você vende e convencem a clicar, sem frases genéricas nem cara de texto de robô.",
    quando: "writing or improving the text people read on a page: headline, subheadline, button/CTA text, section copy, value proposition; \"the text is weak, generic or sounds like AI\".",
    nota: "Write in the language the site already uses (usually Brazilian Portuguese). Never invent testimonials, numbers, client logos or guarantees. Change the words; keep the layout, components and links.",
    arquivos: ["SKILL.md", "LICENSE.txt", "references/ai-tells.md", "references/copy-frameworks.md"],
    usar: {
      rotulo: "Melhorar os textos da página inicial",
      pedido: "✍️ Skill Textos: melhorar os textos da página inicial",
      prompt: `Aplique a skill de textos na PÁGINA INICIAL deste projeto. ${comoAplicar("copywriting", 6)} Reescreva o título principal, o subtítulo, os textos dos botões e os textos das seções para ficarem claros, específicos e convincentes, no idioma em que o site já está.`
    }
  },
  {
    id: "cro",
    nome: "Conversão",
    grupo: "crescimento",
    resumo: "Faz a página transformar visitante em cliente: proposta clara logo no topo, botões no lugar certo, prova de confiança e formulários sem atrito.",
    quando: "making a page convert better: value proposition clarity, headline, CTA placement and hierarchy, trust signals, objections, friction; lead-capture and contact forms; \"this page does not convert\".",
    nota: "Implement the quick wins and the high-impact changes in the code, and put the test ideas in the summary. Write in the site's language. Never invent testimonials, numbers or guarantees.",
    arquivos: ["SKILL.md", "LICENSE.txt", "references/form.md"],
    usar: {
      rotulo: "Revisar a conversão da página inicial",
      pedido: "🎯 Skill Conversão: revisar e melhorar a conversão da página inicial",
      prompt: `Aplique a skill de conversão na PÁGINA INICIAL deste projeto. ${comoAplicar("cro", 8)} Analise na ordem da skill e aplique no código as melhorias de maior impacto.`
    }
  },
  {
    id: "signup",
    nome: "Cadastro",
    grupo: "crescimento",
    resumo: "Telas de cadastro e login que as pessoas terminam: menos campos, erros claros, senha sem dor de cabeça e bom uso no celular.",
    quando: "sign-up, registration, login and account-creation screens: number of fields, validation and error messages, password UX, mobile, what happens right after submit.",
    nota: "Work on the screens and their validation. Do not remove a required database field. Keep the login method the project already uses.",
    arquivos: ["SKILL.md", "LICENSE.txt"],
    usar: {
      rotulo: "Revisar o cadastro e o login",
      pedido: "🔑 Skill Cadastro: revisar as telas de cadastro e login",
      prompt: `Aplique a skill de cadastro nas telas de cadastro e login deste projeto. ${comoAplicar("signup", 8)} Reduza o atrito: campos realmente necessários, mensagens de erro claras e validações amigáveis.`
    }
  },
  {
    id: "supabase-postgres-best-practices",
    nome: "Banco de dados",
    grupo: "tecnico",
    resumo: "Tabelas e consultas bem feitas para o app não ficar lento quando os dados crescem: índices, tipos certos, paginação e buscas eficientes.",
    quando: "designing or changing tables, columns, indexes and queries; slow lists or searches; loading related data; pagination; \"the app gets slow as data grows\".",
    nota: "Lovable Cloud is Supabase Postgres. Check the real schema before proposing anything. In the frontend, select only the columns used, avoid one query per row, and paginate large lists.",
    arquivos: [
      "SKILL.md", "LICENSE.txt",
      "references/query-missing-indexes.md",
      "references/query-composite-indexes.md",
      "references/query-covering-indexes.md",
      "references/query-index-types.md",
      "references/query-partial-indexes.md",
      "references/schema-primary-keys.md",
      "references/schema-data-types.md",
      "references/schema-constraints.md",
      "references/schema-foreign-key-indexes.md",
      "references/schema-lowercase-identifiers.md",
      "references/data-n-plus-one.md",
      "references/data-pagination.md",
      "references/data-batch-inserts.md",
      "references/data-upsert.md",
      "references/advanced-jsonb-indexing.md",
      "references/advanced-full-text-search.md"
    ],
    usar: {
      rotulo: "Revisar o banco de dados",
      pedido: "🗄️ Skill Banco de dados: revisar tabelas e consultas do projeto",
      prompt: `Aplique a skill de banco de dados neste projeto. ${comoAplicar("supabase-postgres-best-practices", 8)} Procure colunas de filtro sem índice, telas que fazem uma consulta por item e listas longas sem paginação.`
    }
  },
  {
    id: "core-web-vitals",
    nome: "Carregamento",
    grupo: "tecnico",
    resumo: "Site que abre rápido e sem \"pulos\" na tela: imagem principal priorizada, fontes que não travam o texto e espaço reservado para o conteúdo.",
    quando: "page loading speed and visual stability: slow first load, PageSpeed / Core Web Vitals score, heavy images or fonts, layout jumping while the page loads.",
    nota: "Fix only causes visible in the code: unreserved image dimensions, non-prioritized hero images, blocking fonts, and layout shifts.",
    arquivos: ["SKILL.md", "LICENSE.txt", "references/LCP.md", "references/INP.md", "references/CLS.md"],
    usar: {
      rotulo: "Acelerar o carregamento do site",
      pedido: "🚀 Skill Carregamento: acelerar a abertura do site",
      prompt: `Aplique a skill de carregamento neste projeto. ${comoAplicar("core-web-vitals", 8)} Comece pela página inicial: priorize imagens de topo, reserve dimensões e evite bloqueio de renderização por fontes.`
    }
  }
];

export function getSkillById(id: string): SkillDefinition | undefined {
  return SKILLS_CATALOG.find(s => s.id === id);
}

export const getSkillDefinition = getSkillById;
export const OFFICIAL_SKILLS_CATALOG = SKILLS_CATALOG;
export const OFFICIAL_TOTAL_SKILLS = 10;
export const OFFICIAL_TOTAL_FILES = 92;

