/**
 * Database Schema Formatter para NekoAI
 * 
 * Converte a estrutura detalhada de esquema do banco PostgreSQL (tabelas, colunas, tipos, PK, FK, RLS, policies, enums)
 * em um formato Markdown altamente conciso e compacto para LLMs, economizando substancialmente o contexto sem perder dados estruturais.
 */

export interface SchemaColumn {
  name: string;
  type: string;
  udtName?: string;
  nullable: boolean;
  default?: string | null;
  isPrimaryKey?: boolean;
}

export interface SchemaForeignKey {
  column: string;
  foreignTable: string;
  foreignColumn: string;
  constraintName?: string;
}

export interface SchemaPolicy {
  name: string;
  command: string;
  roles?: string[];
  permissive?: string;
  using?: string;
  withCheck?: string;
}

export interface SchemaTable {
  name: string;
  schema?: string;
  columns: SchemaColumn[];
  foreignKeys?: SchemaForeignKey[];
  rlsEnabled?: boolean;
  policies?: SchemaPolicy[];
  approxRows?: number;
}

export interface SchemaEnum {
  name: string;
  schema?: string;
  values: string[];
}

export interface StructuredSchemaData {
  tables?: SchemaTable[] | Record<string, any>;
  enums?: SchemaEnum[] | Record<string, string[]>;
  tableCount?: number;
  extractedAt?: string | number;
}

/**
 * Normaliza e formata o esquema estruturado bruto para Markdown compacto.
 */
export function summarizeSchema(schemaData: any): string {
  if (!schemaData || typeof schemaData !== "object") {
    return "Nenhum esquema de banco de dados disponível.";
  }

  const sections: string[] = [];

  // 1. Normaliza tabelas (pode vir como array ou record)
  let tablesList: SchemaTable[] = [];
  if (Array.isArray(schemaData.tables)) {
    tablesList = schemaData.tables;
  } else if (schemaData.tables && typeof schemaData.tables === "object") {
    tablesList = Object.entries(schemaData.tables).map(([tableName, tableObj]: [string, any]) => {
      // Se tableObj já for o formato construído
      return {
        name: tableName,
        schema: tableObj.schema || "public",
        columns: Array.isArray(tableObj.columns)
          ? tableObj.columns
          : Object.entries(tableObj.columns || {}).map(([colName, colObj]: [string, any]) => ({
              name: colName,
              type: colObj.type || colObj.data_type || "text",
              nullable: Boolean(colObj.nullable ?? colObj.is_nullable),
              default: colObj.default || colObj.column_default || null,
              isPrimaryKey: Boolean(colObj.isPrimaryKey || colObj.is_primary_key),
            })),
        foreignKeys: Array.isArray(tableObj.foreignKeys || tableObj.foreign_keys)
          ? (tableObj.foreignKeys || tableObj.foreign_keys)
          : [],
        rlsEnabled: Boolean(tableObj.rlsEnabled ?? tableObj.rls_enabled ?? tableObj.rowsecurity),
        policies: Array.isArray(tableObj.policies) ? tableObj.policies : [],
        approxRows: tableObj.approxRows ?? tableObj.approx_rows,
      };
    });
  }

  // 2. Normaliza Enums
  let enumsList: SchemaEnum[] = [];
  if (Array.isArray(schemaData.enums)) {
    enumsList = schemaData.enums;
  } else if (schemaData.enums && typeof schemaData.enums === "object") {
    enumsList = Object.entries(schemaData.enums).map(([enumName, values]) => ({
      name: enumName,
      values: Array.isArray(values) ? values : [],
    }));
  }

  // Renderiza Enums primeiro, se houver
  if (enumsList.length > 0) {
    sections.push("## Enums");
    for (const e of enumsList) {
      sections.push(`- **${e.name}**: ${e.values.map((v) => `'${v}'`).join(", ")}`);
    }
    sections.push("");
  }

  // Renderiza Tabelas
  if (tablesList.length === 0) {
    if (sections.length === 0) {
      return "Esquema sem tabelas públicas encontradas.";
    }
  } else {
    sections.push("## Tabelas");

    for (const table of tablesList) {
      const fullTableName = table.schema && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name;
      const rlsText = table.rlsEnabled ? "RLS: enabled" : "RLS: disabled";
      const rowsText = typeof table.approxRows === "number" ? ` (~${table.approxRows} linhas)` : "";

      const tableHeader = `### ${fullTableName}\n${rlsText}${rowsText}`;
      const colLines: string[] = [];

      // Colunas
      const cols = Array.isArray(table.columns) ? table.columns : [];
      for (const col of cols) {
        const pkMarker = col.isPrimaryKey ? " PK" : "";
        const nullMarker = col.nullable ? "" : " NOT NULL";
        const defMarker = col.default ? ` default ${col.default}` : "";
        colLines.push(`- ${col.name}: ${col.type}${pkMarker}${nullMarker}${defMarker}`);
      }

      // Foreign Keys
      const fkLines: string[] = [];
      const fks = Array.isArray(table.foreignKeys) ? table.foreignKeys : [];
      for (const fk of fks) {
        const target = fk.foreignTable ? `${fk.foreignTable}(${fk.foreignColumn})` : fk.foreignColumn;
        fkLines.push(`- ${fk.column} → ${target}`);
      }

      // Policies
      const policyLines: string[] = [];
      const policies = Array.isArray(table.policies) ? table.policies : [];
      for (const p of policies) {
        const roles = p.roles && p.roles.length > 0 ? ` [${p.roles.join(",")}]` : "";
        policyLines.push(`- "${p.name}" (${p.command.toUpperCase()}${roles})`);
      }

      let tableBlock = tableHeader + "\n\n" + (colLines.length > 0 ? colLines.join("\n") : "- (sem colunas)");

      if (fkLines.length > 0) {
        tableBlock += "\n\nForeign keys:\n" + fkLines.join("\n");
      }

      if (policyLines.length > 0) {
        tableBlock += "\n\nPolicies:\n" + policyLines.join("\n");
      }

      sections.push(tableBlock);
    }
  }

  return sections.join("\n\n").trim();
}
