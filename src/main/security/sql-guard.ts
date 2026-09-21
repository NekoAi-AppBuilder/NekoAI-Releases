/**
 * SQL Guard — Segurança e Análise Léxica de Queries SQL para NekoAI
 * 
 * Regras Obrigatórias de Segurança:
 * - isReadOnlySql(sql): Validação conservadora para execução exclusiva de leitura.
 * - classifySqlRisk(sql): Categorização estrita em READ, SAFE_WRITE ou DESTRUCTIVE.
 * - sanitizeSqlForDisplay(sql): Mascaramento de dados e formatação segura para exibição.
 * 
 * Filosofia: CONSERVADORA. Em caso de ambiguidade, rejeitar/classificar como DESTRUCTIVE.
 */

export type SqlRiskLevel = "READ" | "SAFE_WRITE" | "DESTRUCTIVE";

export interface SqlValidationResult {
  allowed: boolean;
  risk: SqlRiskLevel;
  reason?: string;
  sanitizedSql?: string;
}

/**
 * Remove comentários SQL (-- linha e /* bloco *\/) e normaliza whitespace.
 * Preserva literais entre aspas simples para não corromper strings legítimas.
 */
export function stripSqlComments(sql: string): string {
  if (!sql || typeof sql !== "string") return "";

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = i + 1 < sql.length ? sql[i + 1] : "";

    // Dentro de comentário de linha (-- ...)
    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += " ";
      }
      continue;
    }

    // Dentro de comentário de bloco (/* ... */)
    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++; // pula o '/'
        result += " ";
      }
      continue;
    }

    // Não estamos em comentário, checa strings
    if (!inSingleQuote && !inDoubleQuote) {
      // Início de comentário de linha: --
      if (char === "-" && nextChar === "-") {
        inLineComment = true;
        i++; // pula o próximo '-'
        continue;
      }
      // Início de comentário de bloco: /*
      if (char === "/" && nextChar === "*") {
        inBlockComment = true;
        i++; // pula o '*'
        continue;
      }
    }

    // Aspas simples
    if (char === "'" && !inDoubleQuote) {
      // Checa escape com duas aspas simples (ex: 'O''Reilly')
      if (inSingleQuote && nextChar === "'") {
        result += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      result += char;
      continue;
    }

    // Aspas duplas (identificadores)
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }

    result += char;
  }

  // Se terminou dentro de comentário de bloco aberto, rejeitamos tratando como vazio/inválido
  if (inBlockComment) {
    return "";
  }

  return result.trim();
}

/**
 * Verifica se existem múltiplas declarações SQL separadas por ponto-e-vírgula.
 * Ignora ponto-e-vírgula contido dentro de strings ('ex;emplo') ou no final da query.
 */
export function hasMultipleStatements(sql: string): boolean {
  if (!sql || typeof sql !== "string") return false;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  const stripped = stripSqlComments(sql);

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ";" && !inSingleQuote && !inDoubleQuote) {
      // Verifica se há caracteres válidos após o ';'
      const remainder = stripped.slice(i + 1).trim();
      if (remainder.length > 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Remove o ponto-e-vírgula final de uma única query, se existir.
 */
export function trimTrailingSemicolon(sql: string): string {
  const stripped = stripSqlComments(sql);
  return stripped.replace(/;\s*$/, "").trim();
}

/**
 * Lista rigorosa de palavras-chave mutadoras ou perigosas.
 * Nenhuma dessas palavras-chave pode aparecer como token SQL fora de aspas em consultas de leitura.
 */
const FORBIDDEN_MUTATION_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "UPSERT",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "RENAME",
  "EXECUTE",
  "EXEC",
  "CALL",
  "VACUUM",
  "REINDEX",
  "REFRESH",
  "DO",
  "MERGE",
  "COPY",
  "LOCK",
  "SET",
  "RESET",
  "DISCARD",
  "INTO" // Bloqueia SELECT ... INTO
];

/**
 * Lista de funções PostgreSQL que possuem efeito colateral mutador ou de execução dinâmica.
 */
const FORBIDDEN_MUTATING_FUNCTIONS = [
  "pg_sleep",
  "dblink",
  "dblink_exec",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "query_to_xml",
  "lo_import",
  "lo_export",
  "lo_unlink"
];

/**
 * Extrai todos os tokens (palavras fora de aspas simples) do SQL limpo.
 */
function extractTokensOutsideQuotes(sql: string): string[] {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let currentToken = "";
  const tokens: string[] = [];

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      if (!inSingleQuote && currentToken) {
        currentToken = "";
      }
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote) {
      // Delimitadores de token: espaço, pontuação, parênteses, vírgula
      if (/[\s(),;]/.test(char)) {
        if (currentToken.length > 0) {
          tokens.push(currentToken);
          currentToken = "";
        }
      } else {
        currentToken += char;
      }
    }
  }

  if (currentToken.length > 0 && !inSingleQuote) {
    tokens.push(currentToken);
  }

  return tokens;
}

/**
 * Validação Conservadora de Read-Only.
 * 
 * Regras:
 * 1. Não pode ser vazia.
 * 2. Comentários não podem esconder caracteres ou deixar blocos abertos.
 * 3. Não pode conter múltiplas declarações encadeadas (;).
 * 4. Deve iniciar com comando de leitura reconhecido: SELECT, WITH ou EXPLAIN.
 * 5. Não pode conter nenhum dos tokens proibidos de mutação (INSERT, UPDATE, DELETE, INTO, etc.).
 * 6. Não pode chamar funções conhecidas de efeitos colaterais.
 */
export function isReadOnlySql(rawSql: string): boolean {
  if (!rawSql || typeof rawSql !== "string" || !rawSql.trim()) {
    return false;
  }

  const cleaned = stripSqlComments(rawSql);
  if (!cleaned) {
    return false; // Era apenas comentário ou comentário de bloco malformado
  }

  if (hasMultipleStatements(rawSql)) {
    return false; // Múltiplas queries bloqueadas
  }

  const singleStatement = trimTrailingSemicolon(cleaned);
  const tokens = extractTokensOutsideQuotes(singleStatement);
  if (tokens.length === 0) {
    return false;
  }

  const firstToken = tokens[0].toUpperCase();

  // Início obrigatório com SELECT, WITH ou EXPLAIN
  if (firstToken !== "SELECT" && firstToken !== "WITH" && firstToken !== "EXPLAIN") {
    return false;
  }

  // Se começou com EXPLAIN, o segundo token relevante (ou subsequente) não pode ser mutador
  // Exemplo: EXPLAIN ANALYZE DELETE ... deve ser bloqueado!
  if (firstToken === "EXPLAIN") {
    const upperTokens = tokens.map((t) => t.toUpperCase());
    const hasMutation = upperTokens.some((t) =>
      ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE"].includes(t)
    );
    if (hasMutation) {
      return false;
    }
  }

  // Se começou com WITH (CTE), em PostgreSQL pode haver: WITH ins AS (INSERT ...) SELECT ...
  // Portanto, NENHUM token mutador pode existir dentro da query inteira!
  const upperTokens = tokens.map((t) => t.toUpperCase());
  for (const forbidden of FORBIDDEN_MUTATION_KEYWORDS) {
    if (upperTokens.includes(forbidden)) {
      return false;
    }
  }

  // Checa funções proibidas
  const lowerTokens = tokens.map((t) => t.toLowerCase());
  for (const fn of FORBIDDEN_MUTATING_FUNCTIONS) {
    if (lowerTokens.includes(fn)) {
      return false;
    }
  }

  return true;
}

/**
 * Classifica o nível de risco de um SQL.
 * 
 * - READ: SELECT, EXPLAIN e WITH estritamente sem mutação.
 * - SAFE_WRITE: Criação ou adição não destrutiva (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX).
 * - DESTRUCTIVE: Qualquer DROP, TRUNCATE, DELETE, UPDATE, ALTER destrutivo, ou em caso de qualquer dúvida/ambiguidade.
 */
export function classifySqlRisk(rawSql: string): SqlRiskLevel {
  if (!rawSql || typeof rawSql !== "string" || !rawSql.trim()) {
    return "DESTRUCTIVE";
  }

  // 1. Se passar na barreira estrita de leitura:
  if (isReadOnlySql(rawSql)) {
    return "READ";
  }

  const cleaned = stripSqlComments(rawSql);
  if (!cleaned) return "DESTRUCTIVE";

  const singleStatement = trimTrailingSemicolon(cleaned);
  const tokens = extractTokensOutsideQuotes(singleStatement);
  const upperTokens = tokens.map((t) => t.toUpperCase());
  const upperSql = singleStatement.toUpperCase();

  // 2. Detecção de Comandos Destrutivos Imateriais
  const destructiveKeywords = ["DROP", "TRUNCATE", "REVOKE", "DELETE"];
  for (const kw of destructiveKeywords) {
    if (upperTokens.includes(kw)) {
      return "DESTRUCTIVE";
    }
  }

  // 3. UPDATE sem WHERE é DESTRUCTIVE
  if (upperTokens.includes("UPDATE")) {
    if (!upperTokens.includes("WHERE")) {
      return "DESTRUCTIVE";
    }
  }

  // 4. ALTER COLUMN destrutivo (ex: DROP COLUMN, DROP CONSTRAINT)
  if (upperTokens.includes("ALTER")) {
    if (upperSql.includes("DROP COLUMN") || upperSql.includes("DROP CONSTRAINT")) {
      return "DESTRUCTIVE";
    }
  }

  // 5. SAFE_WRITE: Adições incrementais sem exclusão
  const isCreateTable = upperTokens.includes("CREATE") && upperTokens.includes("TABLE");
  const isCreateIndex = upperTokens.includes("CREATE") && (upperTokens.includes("INDEX") || upperTokens.includes("UNIQUE"));
  const isAddColumn = upperTokens.includes("ALTER") && upperTokens.includes("TABLE") && upperTokens.includes("ADD");

  if (isCreateTable || isCreateIndex || isAddColumn) {
    return "SAFE_WRITE";
  }

  // Qualquer outra operação ou ambiguidade: DESTRUCTIVE por padrão
  return "DESTRUCTIVE";
}

/**
 * Normaliza o SQL para geração de hash determinístico.
 * Remove comentários, colapsa whitespaces repetidos e converte para minúsculas fora de literais.
 */
export function normalizeSqlForHash(sql: string): string {
  if (!sql || typeof sql !== "string") return "";
  const stripped = stripSqlComments(sql);
  // Colapsa espaços múltiplos e trims
  return stripped.replace(/\s+/g, " ").trim();
}

/**
 * Validação específica para Migrations (P1).
 * 
 * Regras:
 * 1. Não pode ser vazia.
 * 2. Suporta múltiplas statements legítimas (separadas por ';').
 * 3. Deve conter operações DDL ou de modificação estrutural.
 * 4. Rejeita comandos de controle arbitrário de sistema de arquivos ou conexões externas (dblink, lo_import, etc.).
 * 5. Consultas puramente de leitura (READ) são REJEITADAS para migration (devem usar supabase_query_data).
 */
export function validateMigrationSql(rawSql: string): {
  valid: boolean;
  risk: SqlRiskLevel;
  reason?: string;
  affectedTables: string[];
} {
  if (!rawSql || typeof rawSql !== "string" || !rawSql.trim()) {
    return {
      valid: false,
      risk: "DESTRUCTIVE",
      reason: "Instrução SQL da migração vazia ou não informada.",
      affectedTables: []
    };
  }

  const cleaned = stripSqlComments(rawSql);
  if (!cleaned) {
    return {
      valid: false,
      risk: "DESTRUCTIVE",
      reason: "O script contém apenas comentários ou blocos malformados.",
      affectedTables: []
    };
  }

  // Se a query for puramente de leitura, deve ser rejeitada pelo fluxo de migration
  if (isReadOnlySql(rawSql)) {
    return {
      valid: false,
      risk: "READ",
      reason: "Consultas puramente de leitura (SELECT) não devem ser aplicadas como migração. Use supabase_query_data.",
      affectedTables: []
    };
  }

  const tokens = extractTokensOutsideQuotes(cleaned);
  const upperTokens = tokens.map(t => t.toUpperCase());
  const lowerTokens = tokens.map(t => t.toLowerCase());

  // Bloqueia chamadas a funções perigosas de execução arbitrária
  for (const fn of FORBIDDEN_MUTATING_FUNCTIONS) {
    if (lowerTokens.includes(fn)) {
      return {
        valid: false,
        risk: "DESTRUCTIVE",
        reason: `Função de sistema perigosa não permitida em migração: ${fn}`,
        affectedTables: []
      };
    }
  }

  // Rejeita tentativas de alterar banco global (ex: DROP DATABASE)
  if (upperTokens.includes("DATABASE")) {
    return {
      valid: false,
      risk: "DESTRUCTIVE",
      reason: "Operações em nível de banco de dados (DATABASE) não são autorizadas via migração do projeto.",
      affectedTables: []
    };
  }

  // Classifica risco
  const risk = classifySqlRisk(rawSql);
  const affectedTables = extractAffectedTablesFromSql(cleaned);

  return {
    valid: true,
    risk,
    affectedTables
  };
}

/**
 * Extração conservadora e confiável de tabelas afetadas por comandos DDL/DML.
 * Se não for possível identificar com precisão, retorna lista vazia.
 */
export function extractAffectedTablesFromSql(sql: string): string[] {
  if (!sql || typeof sql !== "string") return [];
  const cleaned = stripSqlComments(sql);
  const tables = new Set<string>();

  // Padrões DDL canônicos no PostgreSQL:
  // CREATE TABLE [IF NOT EXISTS] [schema.]table
  // ALTER TABLE [IF EXISTS] [ONLY] [schema.]table
  // DROP TABLE [IF EXISTS] [schema.]table
  // CREATE INDEX ... ON [schema.]table
  // INSERT INTO / UPDATE / DELETE FROM [schema.]table
  const patterns = [
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/gi,
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-zA-Z0-9_."]+)/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/gi,
    /\bON\s+([a-zA-Z0-9_."]+)\s*(?:\(|USING)/gi,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z0-9_."]+)/gi,
    /\bTRUNCATE(?:\s+TABLE)?\s+([a-zA-Z0-9_."]+)/gi
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      let rawName = match[1].trim().replace(/["']/g, "");
      // Remove sufixos se houver
      if (rawName.endsWith("(")) rawName = rawName.slice(0, -1).trim();
      // Não incluir palavras-chave se o regex capturar acidentalmente
      if (!["SELECT", "WHERE", "SET", "VALUES", "IF", "ONLY"].includes(rawName.toUpperCase())) {
        tables.add(rawName);
      }
    }
  }

  return Array.from(tables);
}

/**
 * Sanitiza o SQL para exibição em logs ou na interface, mascarando chaves ou senhas em texto puro.
 */
export function sanitizeSqlForDisplay(sql: string): string {
  if (!sql || typeof sql !== "string") return "";

  return sql
    .replace(/(password\s*=\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2")
    .replace(/(secret\s*=\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2")
    .replace(/(token\s*=\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2")
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .trim();
}

