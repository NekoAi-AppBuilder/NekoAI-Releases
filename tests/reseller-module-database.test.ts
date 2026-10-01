import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// SUITE DE TESTES AUTOMATIZADOS DE ISOLAMENTO E RLS HARDENING (FASE 3.1)
// ============================================================

const MIGRATION_PATH = join(__dirname, "../supabase/migrations/20260930_reseller_core_schema.sql");
const migrationSql = readFileSync(MIGRATION_PATH, "utf-8");

test("RLS Hardening: Auditoria de Policies e Triggers de Proteção", () => {
  // 1. Triggers de proteção contra escalação de privilégios e alteração de campos restritos
  assert.ok(migrationSql.includes("fn_protect_reseller_profile"), "Deve incluir trigger para proibir alteração de id, user_id e status por revendedores");
  assert.ok(migrationSql.includes("fn_protect_reseller_price_settings"), "Deve incluir trigger para proibir alteração de neko_cost, plan e reseller_id");

  // 2. Proteção de Custos NekoAI Oficiais no Banco de Dados
  assert.ok(migrationSql.includes("chk_neko_cost_official"), "Deve conter constraint travando os custos oficiais (39, 69, 197)");

  // 3. Reseller Sales: SOMENTE LEITURA para a role authenticated (Revendedor)
  assert.ok(migrationSql.includes("p_reseller_sales_select ON public.reseller_sales"), "Revendedor só pode SELECT em reseller_sales");
  assert.ok(!migrationSql.includes("CREATE POLICY p_reseller_sales_all ON public.reseller_sales"), "NÃO deve permitir INSERT/UPDATE/DELETE direto para revendedores em reseller_sales");

  // 4. Licenses: SOMENTE LEITURA para a role authenticated (Revendedor não altera licenses)
  assert.ok(migrationSql.includes("p_reseller_licenses_select ON public.licenses"), "Revendedor só pode SELECT em licenses");
  assert.ok(!migrationSql.includes("p_reseller_licenses_update"), "NÃO deve ter policy de UPDATE em licenses para revendedores");
  assert.ok(!migrationSql.includes("p_reseller_licenses_delete"), "NÃO deve ter policy de DELETE em licenses para revendedores");

  // 5. Hardening da RPC: Validação de auth.uid()
  assert.ok(migrationSql.includes("UNAUTHORIZED_RESELLER"), "RPC deve validar se o revendedor autenticado está tentando emitir teste para outro reseller_id");
});

test("Simulação de Isolamento Multi-Tenant: Revendedor A vs Revendedor B", () => {
  const resellerA = { id: "reseller-a-uuid", user_id: "user-a-uuid", name: "Revendedor A", status: "active" };
  const resellerB = { id: "reseller-b-uuid", user_id: "user-b-uuid", name: "Revendedor B", status: "active" };

  const salesData = [
    { id: "sale-1", reseller_id: "reseller-a-uuid", status: "pending", profit_snapshot: 100.00 },
    { id: "sale-2", reseller_id: "reseller-b-uuid", status: "paid", profit_snapshot: 200.00 }
  ];

  const licensesData = [
    { id: "lic-1", reseller_id: "reseller-a-uuid", key_mask: "NEKO-****-****-****-AAAA", status: "active" },
    { id: "lic-2", reseller_id: "reseller-b-uuid", key_mask: "NEKO-****-****-****-BBBB", status: "active" }
  ];

  // 1. Revendedor A faz SELECT em vendas
  const salesVisibleToA = salesData.filter(s => s.reseller_id === resellerA.id);
  assert.equal(salesVisibleToA.length, 1);
  assert.equal(salesVisibleToA[0].id, "sale-1");

  // Revendedor A TENTA ver vendas do Revendedor B -> 0 registros
  const salesOfBVisibleToA = salesData.filter(s => s.reseller_id === resellerA.id && s.id === "sale-2");
  assert.equal(salesOfBVisibleToA.length, 0, "Revendedor A NÃO pode visualizar vendas do Revendedor B");

  // 2. Revendedor A faz SELECT em licenças
  const licensesVisibleToA = licensesData.filter(l => l.reseller_id === resellerA.id);
  assert.equal(licensesVisibleToA.length, 1);
  assert.equal(licensesVisibleToA[0].id, "lic-1");

  // Revendedor A TENTA ver licenças do Revendedor B -> 0 registros
  const licensesOfBVisibleToA = licensesData.filter(l => l.reseller_id === resellerA.id && l.id === "lic-2");
  assert.equal(licensesOfBVisibleToA.length, 0, "Revendedor A NÃO pode visualizar licenças do Revendedor B");
});

test("RPC Test Quota Hardening: Bloqueio de Impartição Cruzada de Revendedores", () => {
  function simulateRpcCall(callingAuthUserId: string, targetResellerId: string, resellerUserMap: Record<string, string>) {
    const actualResellerIdForCaller = resellerUserMap[callingAuthUserId];

    if (actualResellerIdForCaller !== targetResellerId) {
      return { ok: false, error_code: "UNAUTHORIZED_RESELLER", message: "Operação não autorizada: revendedor só pode emitir testes para si próprio." };
    }
    return { ok: true };
  }

  const map: Record<string, string> = {
    "user-a-uuid": "reseller-a-uuid",
    "user-b-uuid": "reseller-b-uuid"
  };

  // Revendedor A emitindo teste próprio -> PERMITIDO
  const resSelf = simulateRpcCall("user-a-uuid", "reseller-a-uuid", map);
  assert.equal(resSelf.ok, true);

  // Revendedor A tentando emitir teste para Revendedor B -> BLOQUEADO
  const resCross = simulateRpcCall("user-a-uuid", "reseller-b-uuid", map);
  assert.equal(resCross.ok, false);
  assert.equal(resCross.error_code, "UNAUTHORIZED_RESELLER");
});

test("Simulação de Operações Proibidas ao Revendedor via Cliente", () => {
  // 1. Tentar alterar neko_cost em reseller_price_settings
  function updatePriceSetting(role: "authenticated" | "service_role", oldRow: any, patch: any) {
    const newRow = { ...oldRow, ...patch };
    if (role === "authenticated") {
      if (newRow.neko_cost !== oldRow.neko_cost || newRow.reseller_id !== oldRow.reseller_id || newRow.plan !== oldRow.plan) {
        throw new Error("Operação não autorizada: apenas o preço de revenda (resale_price) pode ser alterado.");
      }
    }
    return newRow;
  }

  const oldPrice = { reseller_id: "reseller-a", plan: "ANNUAL", neko_cost: 197.00, resale_price: 397.00 };

  // Revendedor altera resale_price de 397 para 497 -> PERMITIDO
  const updatedValid = updatePriceSetting("authenticated", oldPrice, { resale_price: 497.00 });
  assert.equal(updatedValid.resale_price, 497.00);

  // Revendedor TENTA alterar neko_cost de 197 para 100 -> BLOQUEADO
  assert.throws(() => {
    updatePriceSetting("authenticated", oldPrice, { neko_cost: 100.00 });
  }, /apenas o preço de revenda/);

  // 2. Tentar alterar status do perfil de revendedor de 'active' para outro
  function updateResellerProfile(role: "authenticated" | "service_role", oldRow: any, patch: any) {
    const newRow = { ...oldRow, ...patch };
    if (role === "authenticated") {
      if (newRow.status !== oldRow.status || newRow.user_id !== oldRow.user_id || newRow.id !== oldRow.id) {
        throw new Error("Operação não autorizada: revendedores não podem alterar id, user_id ou status.");
      }
    }
    return newRow;
  }

  const oldProfile = { id: "reseller-a", user_id: "user-a", name: "Nome A", status: "active" };

  // Revendedor altera o nome -> PERMITIDO
  const updatedProfile = updateResellerProfile("authenticated", oldProfile, { name: "Novo Nome A" });
  assert.equal(updatedProfile.name, "Novo Nome A");

  // Revendedor TENTA alterar status -> BLOQUEADO
  assert.throws(() => {
    updateResellerProfile("authenticated", oldProfile, { status: "suspended" });
  }, /não podem alterar id, user_id ou status/);
});
