/**
 * Lovable Cloud Intent Detector (FASE 4B - Refinado)
 *
 * Analisa semanticamente se uma solicitação exige acesso, mutação ou
 * introspecção no banco de dados / backend Lovable Cloud.
 *
 * REGRAS FUNDAMENTAIS:
 * 1. Prompts de frontend puro (cores, layouts, landing pages, animações) NÃO exigem banco.
 * 2. Prompts com tabelas visuais / mock / dados fictícios / dados de exemplo NÃO exigem banco.
 * 3. Prompts que criam tabelas reais, migrations, colunas, queries SQL, DDL, DML
 *    ou consultam/carregam dados reais/cadastrados do banco EXIGEM Lovable Cloud.
 * 4. Contexto conversacional é considerado caso o histórico anterior indique persistência.
 */

export interface DatabaseIntentResult {
  requiresDatabase: boolean;
  reason?: string;
  confidence: "high" | "medium" | "low";
}

export function normalizeText(text: string): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectDatabaseIntent(
  prompt: string,
  context?: { conversationHistory?: string[] }
): DatabaseIntentResult {
  const norm = normalizeText(prompt);
  if (!norm) {
    return { requiresDatabase: false, reason: "empty_prompt", confidence: "high" };
  }

  // 1. Sinais negativos: UI pura, mock, dados fictícios, exemplos, layouts sem backend
  const isPureVisual = /\b(visual|mock|mocked|mockado|mockados|mockada|mockadas|mocks|ficticio|ficticios|ficticia|ficticias|fictitious|static|estatico|estaticos|estatica|estaticas|placeholder|dummy|sem\s+backend|sem\s+banco|frontend\s+only|somente\s+frontend|apenas\s+frontend|apenas\s+visual|somente\s+visual|puramente\s+visual|de\s+exemplo|com\s+exemplos?)\b/.test(norm);
  const isPricingTable = /\b(tabela\s+de\s+(precos?|planos?|comparacao|comparativa)|pricing\s+table|comparison\s+table)\b/.test(norm);
  const isVisualTable = /\b(tabela\s+visual|visual\s+table)\b/.test(norm);
  const isLayoutOnly = /\b(layout\s+de|layout\s+do|tela\s+de|pagina\s+de|botao\s+para)\b/.test(norm);

  // Palavras-chave explícitas de banco / persistência real
  const hasExplicitDbKeyword = /\b(no\s+banco|do\s+banco|na\s+base|da\s+base|no\s+postgres|do\s+postgres|in\s+the\s+database|from\s+the\s+database|into\s+the\s+database|from\s+database|in\s+database|into\s+database|migration|migracao|migracoes|migrations|create\s+table|alter\s+table|drop\s+table|insert\s+into|delete\s+from|update\s+[a-z0-9_]+\s+set|clientes\s+reais|dados\s+reais|usuarios\s+reais|produtos\s+reais|pedidos\s+reais)\b/.test(norm);

  // Se for pura tabela visual, de preços, mock ou dados fictícios, e NÃO tiver diretiva explícita de banco: frontend puro
  if ((isPureVisual || isPricingTable || isVisualTable) && !hasExplicitDbKeyword) {
    return { requiresDatabase: false, reason: "pure_visual_mock_frontend", confidence: "high" };
  }

  // 2. PRECEDÊNCIA DE PROMPT MISTO E DADOS REAIS:
  // Se o prompt contém menção inequívoca a carregar/consultar dados reais ou acessar o banco,
  // essa intenção tem precedência sobre filtros de layout simples ("crie uma página de clientes e faça ela carregar os clientes reais do banco").
  const hasMixedRealDataIntent = /\b(carregar|carregue|carregando|buscar|busque|puxar|puxe|consultar|consulte|mostrar|mostre|exibir|exiba)\s+(os\s+|as\s+|o\s+|a\s+)?(clientes|dados|usuarios|produtos|pedidos|registros)\s+reais\b/.test(norm)
    || /\b(clientes|dados|usuarios|produtos|pedidos|registros)\s+reais\s+(no|do|da|na)\s+banco\b/.test(norm)
    || (/\b(carregar|carregue|buscar|busque|puxar|puxe|consultar|consulte)\b/.test(norm) && /\b(no|do)\s+banco\b/.test(norm));

  if (!hasExplicitDbKeyword && !hasMixedRealDataIntent) {
    // Página ou layout simples sem menção a dados reais ou banco
    if (isLayoutOnly && !/\b(dados\s+reais|clientes\s+reais|cadastrados|persistidos?|no\s+banco|do\s+banco|migration|coluna|tabela)\b/.test(norm)) {
      return { requiresDatabase: false, reason: "layout_or_page_only", confidence: "high" };
    }

    // Caso específico: 'crie uma pagina de clientes' simples sem menção a dados/banco
    if (/^crie\s+(uma\s+)?(pagina|tela|view)\s+de\s+[a-z0-9_]+$/.test(norm)) {
      return { requiresDatabase: false, reason: "simple_page_creation", confidence: "high" };
    }
  }

  // 3. Sinais Positivos: DDL / Schema / Migrations
  const ddlPatterns = [
    /\btabela\s+(de\s+)?[a-z0-9_]+(\s+reais)?\s+(no|do|na|da)\s+banco\b/,
    /\b(criar|crie|cria|adicione|adicionar|alterar|altere|modificar|modifique|remover|remova|deletar|delete|create|add|alter|drop)\s+(uma?\s+|a\s+|as\s+|o\s+|os\s+|the\s+|a\s+)?(table|tabela)\b.*(no|do|na|in\s+the|from\s+the|in)\s+(banco|database|db)\b/,
    /\b(criar|crie|cria)\s+([a-z0-9_]+\s+)?(no|do)\s+banco\b/,
    /\b(criar|crie|cria|create)\s+(uma?\s+|a\s+|the\s+)?(tabela|table)\s+[a-z0-9_]+\s+(com|with)\s+(as\s+|the\s+)?(colunas?|campos?|columns?|fields?)\b/,
    /\bcreate\s+table\b/,
    /\balter\s+table\b/,
    /\bdrop\s+table\b/,
    /\b(adicionar|adicione|remover|remova|alterar|altere|modificar|modifique|add|remove|alter)\s+(uma?\s+|a\s+|o\s+|the\s+)?(coluna|column)\s+.*(no|do|na\s+tabela|in\s+the\s+table|in\s+table)\s+(banco|database|db)\b/,
    /\b(adicionar|adicione|remover|remova|alterar|altere|modificar|modifique|add|remove|alter)\s+(uma?\s+|a\s+|o\s+|the\s+)?(coluna|column)\s+[a-z0-9_]+\s+(na|da|para\s+a|in\s+the|to\s+the|in)\s+(tabela|table)\b/,
    /\b(migration|migracao|migracoes|migrations)\b/,
    /\b(primary\s+key|foreign\s+key|chave\s+primaria|chave\s+estrangeira)\b/,
    /\b(criar|crie|create)\s+(um\s+|an?\s+)?(indice|index)\s+(no\s+banco|na\s+tabela|in\s+the\s+database|on\s+table|in\s+database)\b/,
    /\b(relacionamento\s+entre\s+(as\s+)?tabelas|relationship\s+between\s+tables)\b/
  ];

  // 4. Sinais Positivos: DML / Alteração de Dados
  const dmlPatterns = [
    /\b(inserir|insira|salvar|salve|persistir|persista|cadastrar|cadastre|insert|save|persist)\s+.*(no|ao|para\s+o|in\s+the|into\s+the|in|into)\s+(banco|database|db)\b/,
    /\b(inserir|insira|salvar|salve|persistir|persista|cadastrar|cadastre|insert|save)\s+.*(na|para\s+a|into\s+the|in|into)\s+(tabela|table)\s+[a-z0-9_]+\s+(no|do|in\s+the|in)\s+(banco|database|db)\b/,
    /\b(alterar|altere|atualizar|atualize|modificar|modifique|update|modify)\s+(os\s+)?dados\s+(no|do|na\s+tabela|in\s+the\s+database|in\s+the\s+table|in\s+database)\b/,
    /\b(alterar|altere|atualizar|atualize|modificar|modifique|update|modify)\s+(os\s+)?dados\b.*(no|do)\s+banco\b/,
    /\b(alterar|altere|atualizar|atualize|modificar|modifique|update|modify)\s+.*(na\s+tabela|no\s+banco|in\s+the\s+table|in\s+the\s+database|in\s+database|in\s+table)\b/,
    /\b(excluir|exclua|deletar|delete|remover|remova)\s+.*(cadastrados|no\s+banco|do\s+banco|from\s+the|in\s+the)\b/,
    /\btruncate\s+table\b/,
    /\binsert\s+into\b/,
    /\bupdate\s+[a-z0-9_]+\s+set\b/,
    /\bdelete\s+from\b/
  ];

  // 5. Sinais Positivos: DQL / Leitura e Introspecção do Banco
  const dqlPatterns = [
    /\b(consultar|consulte|buscar|busque|puxar|puxe|selecionar|selecione|listar|liste|ler|leia|carregar|carregue|obter|obtenha|query|fetch|select)\s+(os\s+|as\s+|o\s+|a\s+)?(clientes|usuarios|pedidos|produtos|dados|registros)\s+reais\b/,
    /\b(consultar|consulte|buscar|busque|puxar|puxe|selecionar|selecione|listar|liste|ler|leia|carregar|carregue|obter|obtenha|query|fetch|select)\s+.*(no|do|from\s+the|in\s+the|from|in)\s+(banco|database|db)\b/,
    /\b(buscar|busque|listar|liste|consultar|consulte|obter|obtenha|mostrar|mostre)\s+.*(clientes|usuarios|pedidos|registros)\s+cadastrados\b/,
    /\b(ver|veja|mostrar|mostre|consultar|consulte|inspect|view|show)\s+(a\s+|the\s+)?(estrutura|structure|schema)\s+(do|no|of\s+the|in\s+the|of|in)\s+(banco|database|db)\b/,
    /\b(schema|esquema)\s+(do|no|of\s+the|in\s+the|of|in)\s+(banco|database|db)\b/,
    /\b(introspeccao|introspection)\s+(do|no|of\s+the|of)\s+(banco|database|db)\b/,
    /\b(executar|execute|rodar|rode|run)\s+(consulta|query|instrucao)?\s*sql\b/,
    /\bselect\s+.*\s+from\s+[a-z0-9_]+\b/
  ];

  // 6. Menções combinadas de banco de dados
  const generalDbPatterns = [
    /\b(no|do|in\s+the|from\s+the|in|from)\s+(banco\s+de\s+dados|database)\b/,
    /\b(no|do|in\s+the|from\s+the|in|from)\s+postgres(ql)?\b/,
    /\b(no|do|in\s+the|from\s+the|in|from)\s+lovable\s+cloud\b/
  ];

  if (hasMixedRealDataIntent) {
    return { requiresDatabase: true, reason: "mixed_prompt_real_data_dependency", confidence: "high" };
  }

  for (const p of ddlPatterns) {
    if (p.test(norm)) return { requiresDatabase: true, reason: "ddl_schema_operation", confidence: "high" };
  }
  for (const p of dmlPatterns) {
    if (p.test(norm)) return { requiresDatabase: true, reason: "dml_data_operation", confidence: "high" };
  }
  for (const p of dqlPatterns) {
    if (p.test(norm)) return { requiresDatabase: true, reason: "dql_query_operation", confidence: "high" };
  }

  for (const p of generalDbPatterns) {
    if (
      p.test(norm) &&
      /\b(criar|crie|alterar|altere|inserir|insira|atualizar|atualize|deletar|delete|excluir|exclua|remover|remova|consultar|consulte|salvar|salve|persistir|persista|listar|liste|buscar|busque|create|add|update|remove|delete|fetch|query|table|column|record|registro|tabela|coluna)\b/.test(
        norm
      )
    ) {
      return { requiresDatabase: true, reason: "general_db_action", confidence: "medium" };
    }
  }

  // 7. Contexto conversacional
  if (context?.conversationHistory?.length) {
    const recentContext = context.conversationHistory.slice(-3).map(normalizeText).join(" ");
    const hadRecentDbTopic = /\b(tabela|banco|postgres|migration|coluna|clientes\s+reais|dados\s+reais)\b/.test(recentContext);
    if (hadRecentDbTopic && /\b(mostrar|mostre|carregar|carregue|listar|liste|buscar|busque|exibir|exiba|salvar|salve|atualizar|atualize|inserir|insira)\s+.*(nela|dela|deles|na\s+tela|no\s+sistema)\b/.test(norm)) {
      return { requiresDatabase: true, reason: "conversational_db_followup", confidence: "medium" };
    }
  }

  return { requiresDatabase: false, reason: "no_db_action_detected", confidence: "low" };
}
