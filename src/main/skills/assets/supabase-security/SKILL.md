---
name: supabase-security
description: "Auditoria e correção profunda de segurança Supabase: Row Level Security (RLS) e policies, auth claims e sessões, service_role/anon keys no frontend, views com security_invoker, funções SECURITY DEFINER, exposição da Data API e storage buckets. Use quando o usuário pedir 'proteger meu banco', 'dados vazando', 'qualquer um consegue ver os dados', 'erro de permissão no Supabase', 'configurar RLS', 'proteger tabelas', 'usuário acessando dados de outro', 'bloquear acesso anônimo', 'security definer', 'storage público', 'chave exposta' ou 'harden Supabase security'."
license: MIT
metadata:
  author: supabase
  version: "0.2.0"
---

<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: only the principles and the security checklist of the official Supabase skill were kept (CLI, MCP server, documentation lookup and migration workflow were removed), plus one reference from the official Postgres best-practices skill. License: see LICENSE.txt in this folder. -->

# Supabase security

## Core Principles

**1. Verify your work.**
After implementing any fix, run a test query to confirm the change works. A fix without verification is incomplete.

**2. Recover from errors, don't loop.**
If an approach fails after 2-3 attempts, stop and reconsider. Try a different method, check documentation, inspect the error more carefully, and review relevant logs when available. Supabase issues are not always solved by retrying the same command, and the answer is not always in the logs, but logs are often worth checking before proceeding.

**3. Exposing tables to the Data API:** Depending on the user's [Data API settings](https://supabase.com/dashboard/project/<ref>/integrations/data_api/settings), newly created tables may not be automatically exposed via the Data (REST) API. If this is the case, `anon` and `authenticated` roles will need to be explicitly granted access.

> Note that this is separate from RLS, which controls which _rows_ are visible once a table is accessible, not whether the table is accessible at all.

When a user reports a SQL-created table is unexpectedly inaccessible, check their Data API settings and whether the roles have been granted access via explicit `GRANT` SQL. When granting public (`anon`/`authenticated`) access, always enable RLS too. See [Exposing a Table to the Data API](https://supabase.com/docs/guides/api/securing-your-api.md) for the full setup workflow.

**4. RLS in exposed schemas.**
Enable RLS on every table in any exposed schema, which includes `public` by default. This is critical in Supabase because tables in exposed schemas can be reachable through the Data API when the `anon`/`authenticated` roles have access (see [Exposing a Table to the Data API](https://supabase.com/docs/guides/api/securing-your-api.md)). For private schemas, prefer RLS as defense in depth. After enabling RLS, create policies that match the actual access model rather than defaulting every table to the same `auth.uid()` pattern.

**5. Security checklist.**
When working on any Supabase task that touches auth, RLS, views, storage, or user data, run through this checklist. These are Supabase-specific security traps that silently create vulnerabilities:

- **Auth and session security**
  - **Never use `user_metadata` claims in JWT-based authorization decisions.** In Supabase, `raw_user_meta_data` is user-editable and can appear in `auth.jwt()`, so it is unsafe for RLS policies or any other authorization logic. Store authorization data in `raw_app_meta_data` / `app_metadata` instead.
  - **Deleting a user does not invalidate existing access tokens.** Sign out or revoke sessions first, keep JWT expiry short for sensitive apps, and for strict guarantees validate `session_id` against `auth.sessions` on sensitive operations.
  - **If you use `app_metadata` or `auth.jwt()` for authorization, remember JWT claims are not always fresh until the user's token is refreshed.**

- **API key and client exposure**
  - **Never expose the `service_role` or secret key in public clients.** Prefer publishable keys for frontend code. Legacy `anon` keys are only for compatibility.

- **RLS, views, and privileged database code**
  - **Views bypass RLS by default.** In Postgres 15 and above, use `CREATE VIEW ... WITH (security_invoker = true)`. In older versions of Postgres, protect your views by revoking access from the `anon` and `authenticated` roles, or by putting them in an unexposed schema.
  - **UPDATE requires a SELECT policy.** In Postgres RLS, an UPDATE needs to first SELECT the row. Without a SELECT policy, updates silently return 0 rows — no error, just no change.
  - **`auth.role()` is deprecated — use the `TO` clause instead.** Supabase has deprecated `auth.role()` in favour of specifying the target role directly on the policy with `TO authenticated` or `TO anon`. Beyond deprecation, `auth.role() = 'authenticated'` breaks silently when anonymous sign-ins are enabled, because anonymous users carry the `authenticated` Postgres role and pass the check regardless of whether the user is genuinely signed in.
    ```sql
    -- Deprecated (do not use)
    create policy "example" on table_name for select
    using ( auth.role() = 'authenticated' );
    ```
  - **`TO authenticated` alone is authentication without authorization (BOLA / IDOR).** Using `TO authenticated` only checks the role — it does not restrict which rows a user can access. The correct pattern combines `TO authenticated` with an ownership predicate in `USING`:
    ```sql
    create policy "example" on table_name for select
    to authenticated
    using ( (select auth.uid()) = user_id );
    ```
  - **UPDATE policies require both `USING` and `WITH CHECK`.** Without `WITH CHECK`, a user can reassign a row's `user_id` to another user:
    ```sql
    create policy "example" on table_name for update
    to authenticated
    using ( (select auth.uid()) = user_id )
    with check ( (select auth.uid()) = user_id );
    ```
  - **`SECURITY DEFINER` functions bypass RLS.** A `SECURITY DEFINER` function runs with its creator's privileges — typically a role with `bypassrls` (e.g., `postgres`). Never add `SECURITY DEFINER` to resolve a permission error; it silently removes access control without fixing the underlying cause. Prefer `SECURITY INVOKER`.
  - **`SECURITY DEFINER` functions in `public` are callable by all roles.** Postgres grants `EXECUTE` to `PUBLIC` by default for every new function, so any `SECURITY DEFINER` function in `public` is a public API endpoint callable by `anon` and `authenticated` (which inherit from `PUBLIC`) without any additional grant. When `SECURITY DEFINER` is genuinely needed (e.g., bypassing RLS on an internal lookup table), keep the function in a non-exposed schema, and always include an `auth.uid()` check in the function body.

- **Storage access control**
  - **Storage upsert requires INSERT + SELECT + UPDATE.** Granting only INSERT allows new uploads but file replacement (upsert) silently fails. You need all three.

- **RLS performance** → [.agents/skills/supabase-security/references/security-rls-performance.md](.agents/skills/supabase-security/references/security-rls-performance.md)

---

## Ciclo de Execução de Engenharia

Ao receber qualquer tarefa de segurança Supabase, execute o ciclo completo:

1. **Inspecionar:**
   - Verifique o schema do banco e migrações em `supabase/migrations/` (ou schemas locais).
   - Inspecione variáveis de ambiente frontend (`.env`, `.env.local`): garanta que **nunca** existam chaves `service_role` expostas como `VITE_SUPABASE_SERVICE_ROLE` ou `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE`.
   - Identifique quais tabelas têm RLS ativado e quais policies existem.

2. **Planejar:**
   - Mapeie quem deve ler, criar, alterar e deletar cada registro (owner, membros da organização, admin ou público).
   - Para updates, planeje tanto o predicado `USING` (quais linhas podem ser selecionadas para update) quanto `WITH CHECK` (quais novos valores são permitidos).

3. **Implementar:**
   - Crie uma migração SQL clara e idempotente em `supabase/migrations/<timestamp>_<desc>.sql` ou aplique conforme o padrão do projeto.
   - Ative RLS explicitamente: `ALTER TABLE <nome> ENABLE ROW LEVEL SECURITY;`.
   - Crie policies específicas por operação (SELECT, INSERT, UPDATE, DELETE) usando `TO authenticated` ou `TO anon` em vez do deprecado `auth.role()`.
   - Em views expostas, garanta `WITH (security_invoker = true)`.

4. **Validar:**
   - Verifique a sintaxe SQL e cheque se não há recursão infinita em policies que consultam a mesma tabela (leia o guia de performance RLS).
   - Confirme que queries autenticadas filtram por `(select auth.uid()) = user_id` de forma sargable com índices.

5. **Reportar:**
   - Descreva as tabelas protegidas, políticas aplicadas e garantias de isolamento de dados verificadas.
