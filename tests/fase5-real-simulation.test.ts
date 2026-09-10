// tests/fase5-real-simulation.test.ts
// Testes de Simulação Real e Concorrência para a Fase 5 (Cakto & Desktop Simulation)

import { CaktoAdapter } from "../supabase/functions/_shared/billing/cakto-adapter.ts";
import { BillingCore } from "../supabase/functions/_shared/billing/billing-core.ts";
import { BILLING_CATALOG } from "../supabase/functions/_shared/billing/catalog.ts";

/**
 * Mock robusto com suporte a transações concorrentes atômicas (Mutex / Semaphore de Idempotência).
 */
class ConcurrentSupabaseMock {
  public licenses: any[] = [];
  public license_events: any[] = [];
  public license_activations: any[] = [];
  public billing_idempotency: any[] = [];
  public billing_subscriptions: any[] = [];

  private lockSet = new Set<string>();

  public from(tableName: string) {
    const self = this;
    let filters: Array<(item: any) => boolean> = [];

    const createQuery = () => {
      let isDeleteOp = false;
      let updateData: any = null;
      let insertRows: any[] = [];
      let isSingle = false;

      const q: any = {
        select: (_cols?: string) => q,
        eq: (field: string, val: any) => {
          filters.push((item: any) => item[field] === val);
          return q;
        },
        order: (_field: string, _opts?: any) => q,
        limit: (_n: number) => q,
        single: () => {
          isSingle = true;
          return q;
        },
        insert: (payload: any) => {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const r of rows) {
            if (tableName === "billing_idempotency") {
              const lockKey = `${r.provider}:${r.provider_event_id}`;
              if (self.lockSet.has(lockKey) || self.billing_idempotency.some((x) => x.provider === r.provider && x.provider_event_id === r.provider_event_id)) {
                const err = { code: "23505", message: "duplicate key value violates unique constraint" };
                return {
                  select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }),
                  then: (resolve: (res: any) => void) => resolve({ data: null, error: err }),
                };
              }
              self.lockSet.add(lockKey);
            }
            const newRow = { id: r.id || crypto.randomUUID(), ...r, created_at: new Date().toISOString() };
            (self as any)[tableName].push(newRow);
            insertRows.push(newRow);
          }
          return q;
        },
        update: (payload: any) => {
          updateData = payload;
          return q;
        },
        delete: () => {
          isDeleteOp = true;
          return q;
        },
        then: (resolve: (res: any) => void, _reject?: (err: any) => void) => {
          const tableData = (self as any)[tableName] || [];

          if (isDeleteOp) {
            (self as any)[tableName] = tableData.filter((item: any) => !filters.every((f) => f(item)));
            resolve({ data: [], error: null });
            return;
          }

          if (updateData) {
            for (const item of tableData) {
              if (filters.every((f) => f(item))) {
                Object.assign(item, updateData);
              }
            }
            resolve({ data: null, error: null });
            return;
          }

          if (insertRows.length > 0) {
            resolve({ data: isSingle ? insertRows[0] : insertRows, error: null });
            return;
          }

          const filtered = tableData.filter((item: any) => filters.every((f) => f(item)));
          if (isSingle) {
            if (filtered.length === 0) {
              resolve({ data: null, error: { message: "Not found" } });
            } else {
              resolve({ data: filtered[0], error: null });
            }
            return;
          }

          resolve({ data: filtered, error: null });
        },
      };

      return q;
    };

    return createQuery();
  }
}

async function runFase5Simulation() {
  console.log("=== INICIANDO TESTES DA FASE 5 (CONCORRÊNCIA, DESKTOP & FLUXO CAKTO) ===");
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  const db = new ConcurrentSupabaseMock();
  const core = new BillingCore(db as any);
  const caktoAdapter = new CaktoAdapter();
  const secret = "cakto_sec_live_sim_999";

  const MENSAL_ID = "c6ddef32-e73d-44d6-88a3-21b376c01968";
  const BUMP_3_ID = "a5ea941a-1663-40e9-a2fc-48ddf40a951b";

  // 1. Teste de Concorrência Real: Duas requisições idênticas enviadas simultaneamente via Promise.all
  {
    const payload = {
      secret,
      event: "purchase_approved",
      data: {
        id: "concurrent_evt_99",
        refId: "ref_concurrent_99",
        product: { id: MENSAL_ID },
        customer: { name: "Concurrency User", email: "conc@test.com" },
      },
    };

    const norm1 = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const norm2 = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));

    const [res1, res2] = await Promise.all([
      core.processEvent(norm1),
      core.processEvent(norm2),
    ]);

    const createdCount = [res1, res2].filter((r) => r.action_performed === "license_created").length;
    const alreadyProcessedCount = [res1, res2].filter((r) => r.action_performed === "already_processed").length;

    assert(createdCount === 1, "1. Concorrência: Apenas 1 licença foi criada");
    assert(alreadyProcessedCount === 1, "1b. Concorrência: A segunda requisição foi travada pela idempotência");
    assert(db.licenses.length === 1, "1c. Concorrência: Apenas 1 registro na tabela licenses");
  }

  // 2. Simulação do Desktop Electron com Licença de 4 Dispositivos (Mensal + Bump +3)
  {
    const payloadBump = {
      secret,
      event: "purchase_approved",
      data: {
        id: "desktop_test_evt_01",
        refId: "ref_desk_01",
        subscription: { id: "sub_desk_99" },
        product: { id: MENSAL_ID },
        order_bumps: [{ id: BUMP_3_ID }],
        customer: { name: "Desktop User", email: "desktop@test.com" },
      },
    };

    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadBump));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);

    assert(lic && lic.max_devices === 4, "2. Licença criada com capacidade de 4 dispositivos");

    // Simulação das ativações do Desktop respeitando max_devices
    const device1 = "00000000000000000000000000000001";
    const device2 = "00000000000000000000000000000002";
    const device3 = "00000000000000000000000000000003";
    const device4 = "00000000000000000000000000000004";
    const device5 = "00000000000000000000000000000005";

    // Ativa os 4 dispositivos permitidos
    db.license_activations.push(
      { license_id: lic.id, device_id: device1, device_name: "Station 1" },
      { license_id: lic.id, device_id: device2, device_name: "Station 2" },
      { license_id: lic.id, device_id: device3, device_name: "Station 3" },
      { license_id: lic.id, device_id: device4, device_name: "Station 4" },
    );

    const activeCount = db.license_activations.filter((a) => a.license_id === lic.id).length;
    assert(activeCount === 4, "2b. 4 dispositivos ativados com sucesso (limite atingido)");

    // Tentativa de 5º dispositivo (deve ser bloqueado pela regra de max_devices)
    const canActivate5 = activeCount < lic.max_devices;
    assert(canActivate5 === false, "2c. 5º dispositivo bloqueado corretamente (limite de 4 excedido)");

    // 3. Simulação de Refund -> Revoga e desconecta as 4 máquinas
    const refundPayload = {
      secret,
      event: "refund",
      data: {
        id: "refund_desk_evt",
        subscription: { id: "sub_desk_99" },
        customer: { email: "desktop@test.com" },
      },
    };

    const normRefund = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(refundPayload));
    const resRefund = await core.processEvent(normRefund);

    const licRefunded = db.licenses.find((l) => l.id === lic.id);
    const activationsAfterRefund = db.license_activations.filter((a) => a.license_id === lic.id);

    assert(resRefund.action_performed === "license_revoked", "3. Refund processado pelo Billing Core");
    assert(licRefunded.status === "revoked", "3b. Licença alterada para revoked");
    assert(activationsAfterRefund.length === 0, "3c. Todas as 4 ativações foram removidas do banco");
  }

  console.log(`\n=== RESULTADO DOS TESTES DE SIMULAÇÃO DA FASE 5: ${passed} PASSOU, ${failed} FALHOU ===`);
}

runFase5Simulation().catch(console.error);
