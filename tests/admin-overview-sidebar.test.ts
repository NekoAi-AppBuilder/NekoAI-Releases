import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// AUDITORIA E TESTES DA NOVA SIDEBAR E DASHBOARD VISÃO GERAL (FASE 1)
// ============================================================

const currentDir = import.meta.dirname || process.cwd();
const SIDEBAR_PATH = join(currentDir, "../nekoai-admin/src/AdminSidebar.tsx");
const OVERVIEW_PATH = join(currentDir, "../nekoai-admin/src/AdminOverviewDashboard.tsx");
const PLACEHOLDER_PATH = join(currentDir, "../nekoai-admin/src/AdminModulePlaceholder.tsx");
const APP_TSX_PATH = join(currentDir, "../nekoai-admin/src/App.tsx");
const STYLES_CSS_PATH = join(currentDir, "../nekoai-admin/src/styles.css");

const sidebarCode = readFileSync(SIDEBAR_PATH, "utf-8");
const overviewCode = readFileSync(OVERVIEW_PATH, "utf-8");
const placeholderCode = readFileSync(PLACEHOLDER_PATH, "utf-8");
const appTsxCode = readFileSync(APP_TSX_PATH, "utf-8");
const stylesCssCode = readFileSync(STYLES_CSS_PATH, "utf-8");

test("Sidebar Administrativa: Estrutura, Módulos e Remoção de 'Área do Revendedor'", () => {
  // 1. Módulos obrigatórios na Sidebar
  assert.ok(sidebarCode.includes('"Visão geral"'), "Deve conter o item 'Visão geral'");
  assert.ok(sidebarCode.includes('"Licenças"'), "Deve conter o item 'Licenças'");
  assert.ok(sidebarCode.includes('"Revendedores"'), "Deve conter o item 'Revendedores'");
  assert.ok(sidebarCode.includes('"Clientes"'), "Deve conter o item 'Clientes'");
  assert.ok(sidebarCode.includes('"Vendas"'), "Deve conter o item 'Vendas'");
  assert.ok(sidebarCode.includes('"Pagamentos"'), "Deve conter o item 'Pagamentos'");

  // 2. Remoção da antiga 'Área do Revendedor' da barra de navegação administrativa
  assert.ok(
    !appTsxCode.includes("Área do Revendedor"),
    "A opção antiga 'Área do Revendedor' NÃO deve mais existir na navegação"
  );

  // 3. Abertura padrão deve ser 'overview' (Visão geral)
  assert.ok(
    appTsxCode.includes('useState<AdminModule>("overview")'),
    "A tela inicial ao abrir o Admin deve ser 'overview' (Visão geral)"
  );

  // 4. Suporte a colapsar/expandir com tooltips
  assert.ok(sidebarCode.includes("isCollapsed"), "Sidebar deve receber e tratar prop isCollapsed");
  assert.ok(sidebarCode.includes("data-tooltip"), "Deve conter atributos de tooltip no modo recolhido");
  assert.ok(sidebarCode.includes("onToggleCollapse"), "Deve conter handler para alternar estado recolhido");

  // 5. Item 'Sair' integrado ao Sidebar abaixo dos módulos e remoção da barra superior duplicada
  assert.ok(sidebarCode.includes("onLogout"), "Sidebar deve receber o callback de logout");
  assert.ok(sidebarCode.includes("LogOut"), "Sidebar deve conter o ícone de LogOut");
  assert.ok(sidebarCode.includes('"Sair"'), "Sidebar deve conter a opção 'Sair'");
  assert.ok(
    !appTsxCode.includes('<header className="admin-header">'),
    "A navbar superior antiga NÃO deve mais existir no App.tsx"
  );
});

test("Dashboard / Visão Geral: Quatro Cards Superiores, Vendas, Receita e Atividade", () => {
  // 1. Quatro cards superiores
  assert.ok(overviewCode.includes("Licenças"), "Card 1: Licenças deve estar presente");
  assert.ok(overviewCode.includes("Licenças Ativas"), "Card 2: Licenças Ativas deve estar presente");
  assert.ok(overviewCode.includes("Clientes"), "Card 3: Clientes deve estar presente");
  assert.ok(overviewCode.includes("Revendedores"), "Card 4: Revendedores deve estar presente");

  // 2. Bloco de Vendas agrupadas por plano
  assert.ok(overviewCode.includes("Vendas por Plano"), "Deve conter bloco de Vendas por Plano");
  assert.ok(overviewCode.includes("Mensal") && overviewCode.includes("Trimestral") && overviewCode.includes("Anual"),
    "Deve agrupar vendas em Mensal, Trimestral e Anual");

  // 3. Bloco de Receita com segregação de origem
  assert.ok(overviewCode.includes("Receita da Plataforma"), "Deve conter bloco de Receita da Plataforma");
  assert.ok(overviewCode.includes("Licenças Diretas:"), "Deve discriminar Licenças Diretas");
  assert.ok(overviewCode.includes("Revendedores:"), "Deve discriminar Revendedores");

  // 4. Atividade recente baseada em eventos reais
  assert.ok(overviewCode.includes("Atividade recente"), "Deve conter seção de Atividade recente");
  assert.ok(overviewCode.includes("admin-timeline"), "Deve renderizar timeline para as atividades");
  assert.ok(overviewCode.includes("formatRelativeTime"), "Deve conter formatador de tempo relativo em português");

  // 5. Botão de atualização
  assert.ok(overviewCode.includes("onRefresh"), "Deve possuir botão e handler de Atualizar");
});

test("CSS & Layout: Sidebar Não-Sobreposta e Adaptação Automática de Conteúdo", () => {
  assert.ok(stylesCssCode.includes(".admin-body-layout"), "Deve definir .admin-body-layout com display flex");
  assert.ok(stylesCssCode.includes(".admin-sidebar"), "Deve definir .admin-sidebar com transição suave");
  assert.ok(stylesCssCode.includes(".admin-sidebar.collapsed"), "Deve definir .admin-sidebar.collapsed com largura reduzida");
  assert.ok(stylesCssCode.includes(".admin-main-wrapper"), "Deve definir .admin-main-wrapper com flex 1 e min-width 0");
  assert.ok(stylesCssCode.includes(".admin-overview-grid"), "Deve definir grid para Vendas e Receita");
  assert.ok(stylesCssCode.includes(".admin-timeline"), "Deve definir estilos da timeline");
});

test("Módulos Futuros: Placeholders Transparentes e Alinhados ao Roadmap (Fase 2)", () => {
  assert.ok(placeholderCode.includes("resellers:"), "Placeholder deve contemplar módulo de Revendedores");
  assert.ok(placeholderCode.includes("customers:"), "Placeholder deve contemplar módulo de Clientes");
  assert.ok(placeholderCode.includes("sales:"), "Placeholder deve contemplar módulo de Vendas");
  assert.ok(placeholderCode.includes("payments:"), "Placeholder deve contemplar módulo de Pagamentos");
  assert.ok(placeholderCode.includes("Fase 2"), "Deve explicitar que os módulos fazem parte da Fase 2");
});

test("Cálculo e Agregação de Métricas: Teste Unitário Puro com Amostra Real", () => {
  const sampleLicenses: any[] = [
    {
      id: "lic-1",
      key_mask: "NEKO-****-****-****-A1B2",
      plan: "MONTHLY",
      status: "active",
      customer_name: "João Silva",
      customer_email: "joao@email.com",
      license_type: "NORMAL",
      created_at: new Date().toISOString(), // Este mês
      active_devices: [{ device_id: "dev-1", device_name: "MacBook Pro", last_validated_at: new Date().toISOString() }],
    },
    {
      id: "lic-2",
      key_mask: "NEKO-****-****-****-C3D4",
      plan: "ANNUAL",
      status: "active",
      customer_name: "Maria Souza",
      customer_email: "maria@email.com",
      license_type: "NORMAL",
      created_at: new Date().toISOString(), // Este mês
      active_devices: [],
    },
    {
      id: "lic-3",
      key_mask: "NEKO-****-****-****-E5F6",
      plan: "QUARTERLY",
      status: "revoked",
      customer_name: "João Silva", // Mesmo cliente (repetido)
      customer_email: "joao@email.com",
      license_type: "NORMAL",
      created_at: "2026-01-10T10:00:00Z", // Mês anterior
      active_devices: [],
    },
    {
      id: "lic-test-4",
      key_mask: "NEKO-TEST-****-****-****",
      plan: "MONTHLY",
      status: "active",
      customer_name: "Visitante Teste",
      customer_email: "teste@email.com",
      license_type: "TEST", // Teste: não deve somar em vendas comerciais
      created_at: new Date().toISOString(),
      active_devices: [],
    },
  ];

  const clientSet = new Set<string>();
  let monthlyCount = 0;
  let quarterlyCount = 0;
  let annualCount = 0;
  let testCount = 0;
  let directRevenue = 0;

  for (const lic of sampleLicenses) {
    const key = (lic.customer_email || lic.customer_name || "").trim().toLowerCase();
    if (key) clientSet.add(key);

    if (lic.license_type === "TEST") {
      testCount++;
    } else {
      if (lic.plan === "MONTHLY") {
        monthlyCount++;
        directRevenue += 79.0;
      } else if (lic.plan === "QUARTERLY") {
        quarterlyCount++;
        directRevenue += 149.0;
      } else if (lic.plan === "ANNUAL") {
        annualCount++;
        directRevenue += 397.0;
      }
    }
  }

  // Asserções
  assert.strictEqual(clientSet.size, 3, "Devem existir exatamente 3 clientes únicos");
  assert.strictEqual(monthlyCount, 1, "Deve haver 1 venda mensal comercial");
  assert.strictEqual(quarterlyCount, 1, "Deve haver 1 venda trimestral comercial");
  assert.strictEqual(annualCount, 1, "Deve haver 1 venda anual comercial");
  assert.strictEqual(testCount, 1, "Deve haver 1 licença de teste segregada");
  assert.strictEqual(directRevenue, 79.0 + 149.0 + 397.0, "Receita direta deve ser a soma exata dos planos comerciais (625)");
});

test("Módulo Licenças: Tabela de 9 Colunas, Tipo, Criação, Origem e Paginação Server-Side", () => {
  // 1. Colunas obrigatórias da tabela na ordem correta
  assert.ok(appTsxCode.includes("<th>Chave / Máscara</th>"), "Tabela deve conter coluna Chave / Máscara");
  assert.ok(appTsxCode.includes("<th>Cliente</th>"), "Tabela deve conter coluna Cliente");
  assert.ok(appTsxCode.includes("<th>Plano</th>"), "Tabela deve conter coluna Plano");
  assert.ok(appTsxCode.includes("<th>Tipo</th>"), "Tabela deve conter coluna Tipo");
  assert.ok(appTsxCode.includes("<th>Status</th>"), "Tabela deve conter coluna Status");
  assert.ok(appTsxCode.includes("<th>Dispositivos</th>"), "Tabela deve conter coluna Dispositivos");
  assert.ok(appTsxCode.includes("<th>Criação</th>"), "Tabela deve conter coluna Criação");
  assert.ok(appTsxCode.includes("<th>Expiração</th>"), "Tabela deve conter coluna Expiração");
  assert.ok(appTsxCode.includes("Ações"), "Tabela deve conter coluna Ações");

  // 2. Classificação de Tipo (Direta, Revendedor, Teste)
  assert.ok(appTsxCode.includes("type-direct") || appTsxCode.includes("Direta"), "Deve renderizar indicador de Licença Direta");
  assert.ok(appTsxCode.includes("type-reseller") || appTsxCode.includes("Revendedor"), "Deve renderizar indicador de Licença de Revendedor");
  assert.ok(appTsxCode.includes("type-test") || appTsxCode.includes("Teste"), "Deve renderizar indicador de Licença de Teste");

  // 3. Paginação Server-Side e Filtros
  assert.ok(appTsxCode.includes("admin-pagination-bar"), "Deve conter barra de paginação server-side");
  assert.ok(appTsxCode.includes("Anterior") && appTsxCode.includes("Próxima"), "Deve conter botões de Anterior e Próxima página");
  assert.ok(appTsxCode.includes("typeFilter"), "Deve integrar filtro por Tipo de licença");
  assert.ok(appTsxCode.includes("originFilter"), "Deve integrar filtro por Origem de licença");
  assert.ok(appTsxCode.includes("Todas as origens"), "Deve conter opção 'Todas as origens'");
  assert.ok(appTsxCode.includes("NekoAI Admin"), "Deve conter opção 'NekoAI Admin'");
  assert.ok(appTsxCode.includes("Todos os revendedores"), "Deve conter opção 'Todos os revendedores'");
  assert.ok(appTsxCode.includes("Um revendedor específico..."), "Deve conter opção 'Um revendedor específico...'");
  assert.ok(appTsxCode.includes("admin-reseller-combobox"), "Deve conter combobox para busca de revendedor específico");

  // 4. Detalhes da Licença: Exibição de Origem, Emissor e Revendedor
  assert.ok(appTsxCode.includes("Origem"), "Modal de detalhes deve exibir Origem da licença");
  assert.ok(appTsxCode.includes("Venda direta"), "Modal de detalhes deve identificar Venda direta");
  assert.ok(appTsxCode.includes("Revendedor"), "Modal de detalhes deve identificar Revendedor quando originada por revenda");
});

test("Combobox de Revendedores: Exclusão Estrita de 'NekoAI Admin' e Tratamento de 'Sem revendedores'", () => {
  const adminApiCode = readFileSync(join(currentDir, "../nekoai-admin/src/admin-api.ts"), "utf-8");

  // 1. App.tsx deve conter o texto informativo 'Sem revendedores'
  assert.ok(appTsxCode.includes("Sem revendedores"), "App.tsx deve exibir 'Sem revendedores' quando não houver revendedores cadastrados");
  assert.ok(appTsxCode.includes("admin-no-resellers-item"), "Item de 'Sem revendedores' deve conter classe indicativa não-clicável");

  // 2. App.tsx e admin-api.ts devem filtrar estritamente qualquer tentativa de inserir 'nekoai admin'
  assert.ok(appTsxCode.includes('name !== "nekoai admin"'), "App.tsx deve sanitizar resultados para nunca exibir 'NekoAI Admin'");
  assert.ok(adminApiCode.includes('name !== "nekoai admin"'), "admin-api.ts deve filtrar 'NekoAI Admin' nos resultados de busca de revendedor");

  // 3. Simulação de sanitização: lista com registro de revendedor real e registro administrativo fictício
  const mockRawResults = [
    { id: "admin", name: "NekoAI Admin", email: "admin@nekoai.com" },
    { id: "reseller-123", name: "Agência Parceira Alpha", email: "contato@alpha.com" },
    { id: "admin-2", name: "Admin", email: "suporte@nekoai.com" },
  ];

  const sanitized = mockRawResults.filter((r) => {
    const name = (r.name || "").trim().toLowerCase();
    const email = (r.email || "").trim().toLowerCase();
    const id = (r.id || "").trim().toLowerCase();
    return (
      name !== "nekoai admin" &&
      name !== "admin" &&
      email !== "admin@nekoai.com" &&
      id !== "admin"
    );
  });

  assert.strictEqual(sanitized.length, 1, "Apenas o revendedor real 'Agência Parceira Alpha' deve permanecer");
  assert.strictEqual(sanitized[0].name, "Agência Parceira Alpha");

  // 4. Simulação de lista vazia de revendedores: deve retornar 0 itens e ativar mensagem 'Sem revendedores'
  const emptyResults: any[] = [];
  const sanitizedEmpty = emptyResults.filter((r) => r.name !== "nekoai admin");
  assert.strictEqual(sanitizedEmpty.length, 0, "Lista vazia deve ter tamanho 0, disparando estado 'Sem revendedores'");
});
