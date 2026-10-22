---
name: supabase-postgres-best-practices
description: "Otimização avançada de banco de dados PostgreSQL e Supabase: criação e alteração de tabelas, tipos de dados ideais, criação de índices (B-Tree, GIN, GiST), eliminação de N+1 queries, paginação por cursor, chaves estrangeiras indexadas, constraints seguras, full-text search e JSONB. Use quando o usuário disser 'banco de dados lento', 'queries demorando', 'criar tabela no Supabase', 'otimizar banco', 'adicionar índices', 'relacionamento entre tabelas', 'timeout no banco', 'modelagem de banco' ou 'postgres best practices'."
license: MIT
metadata:
  author: supabase
  version: "1.2.0"
  organization: Supabase
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: 16 of the rules are included (queries and indexes, schema design, data access, advanced features); connection management, monitoring, locking, partitioning and the security rules were left out, and the "Rule files" index was added from each rule's own title. License: see LICENSE.txt in this folder. -->

# Supabase Postgres Best Practices

Comprehensive performance optimization guide for Postgres, maintained by Supabase. Contains rules across 4 categories, prioritized by impact to guide automated query optimization and schema design.

## When to Apply

Reference these guidelines when:
- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Optimizing for Postgres-specific features

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Query Performance | CRITICAL | `query-` |
| 4 | Schema Design | HIGH | `schema-` |
| 6 | Data Access Patterns | MEDIUM | `data-` |
| 8 | Advanced Features | LOW | `advanced-` |

## Como Consultar os Playbooks Técnicos

Consulte os playbooks detalhados diretamente em seus caminhos no projeto:

- `.agents/skills/supabase-postgres-best-practices/references/query-missing-indexes.md` — Adicionar índices em colunas de WHERE e JOIN (CRITICAL)
- `.agents/skills/supabase-postgres-best-practices/references/query-composite-indexes.md` — Índices compostos para queries multicoluna (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/query-covering-indexes.md` — Índices de cobertura (INCLUDE) para evitar lookups (MEDIUM-HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/query-index-types.md` — Selecionar o tipo de índice ideal (B-Tree, GIN, GiST, BRIN) (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/query-partial-indexes.md` — Índices parciais com filtro WHERE (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/schema-primary-keys.md` — Estratégia ótima de Primary Key (UUID vs BIGINT) (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/schema-data-types.md` — Escolha ideal de tipos de dados (TIMESTAMPTZ, TEXT, NUMERIC) (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/schema-constraints.md` — Adição segura de constraints em migrações (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/schema-foreign-key-indexes.md` — Indexar colunas de Foreign Keys (HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/schema-lowercase-identifiers.md` — Identificadores em minúsculas (snake_case) (MEDIUM)
- `.agents/skills/supabase-postgres-best-practices/references/data-n-plus-one.md` — Eliminar N+1 com batching ou JOINs no Supabase (MEDIUM-HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/data-pagination.md` — Paginação por cursor em vez de OFFSET elevado (MEDIUM-HIGH)
- `.agents/skills/supabase-postgres-best-practices/references/data-batch-inserts.md` — Inserções em lote para alta performance (MEDIUM)
- `.agents/skills/supabase-postgres-best-practices/references/data-upsert.md` — ON CONFLICT DO UPDATE (UPSERT) (MEDIUM)
- `.agents/skills/supabase-postgres-best-practices/references/advanced-jsonb-indexing.md` — Índices GIN em colunas JSONB (MEDIUM)
- `.agents/skills/supabase-postgres-best-practices/references/advanced-full-text-search.md` — Busca textual eficiente com tsvector e índices GIN (MEDIUM)

---

## Ciclo de Execução de Engenharia

Ao criar ou otimizar estruturas no Postgres/Supabase:

1. **Inspecionar:**
   - Inspecione as migrações existentes em `supabase/migrations/` e queries no código frontend/backend.
   - Identifique consultas lentas, colunas de Foreign Key não indexadas (`REFERENCES`) e ausência de índices em filtros frequentes.

2. **Planejar:**
   - Projete a alteração em SQL compatível com Postgres (usar snake_case, tipos explícitos como `timestamptz`).
   - Se for adicionar índices em tabelas em produção, planeje o uso de `CREATE INDEX IF NOT EXISTS`.

3. **Implementar:**
   - Crie uma migração SQL versionada em `supabase/migrations/<timestamp>_<nome>.sql`.
   - Adicione chaves estrangeiras com índices explícitos na tabela de origem.
   - Para JSONB, crie índices GIN específicos (`jsonb_path_ops`).

4. **Validar:**
   - Verifique a sintaxe SQL e cheque se a migração pode ser executada sem travar o banco ou quebrar schemas existentes.
   - Assegure que as chamadas client-side (via Supabase JS) utilizam `.select('..., foreign_table(...)')` corretamente sem induzir N+1.

5. **Reportar:**
   - Documente a migração SQL gerada, índices criados e o ganho esperado de eficiência nas consultas.
