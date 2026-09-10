// tests/billing-core.test.ts
// Testes unitários locais para a máquina de regras do Billing Core, Cakto Adapter e SyncPay Adapter

import { SyncPayAdapter } from "../supabase/functions/_shared/billing/syncpay-adapter.ts";
import { CaktoAdapter } from "../supabase/functions/_shared/billing/cakto-adapter.ts";
import { BillingCore } from "../supabase/functions/_shared/billing/billing-core.ts";
import { BILLING_CATALOG } from "../supabase/functions/_shared/billing/catalog.ts";

/**
 * Mock em memória do Supabase Client fiel ao comportamento assíncrono e encadeamento da SDK.
 */
class InMemorySupabaseMock {
  public licenses: any[] = [];
  public license_events: any[] = [];
  public license_activations: any[] = [];
  public billing_idempotency: any[] = [];
  public billing_subscriptions: any[] = [];

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
              const exists = self.billing_idempotency.some(
                (x) => x.provider === r.provider && x.provider_event_id === r.provider_event_id
              );
              if (exists) {
                const err = { code: "23505", message: "duplicate key" };
                return {
                  select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }),
                  then: (resolve: (res: any) => void) => resolve({ data: null, error: err }),
                };
              }
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

async function runBillingTests() {
  console.log("=== INICIANDO SUÍTE DE TESTES DO NEKOAI BILLING CORE (SYNCPAY + CAKTO) ===");
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

  // Prepara catálogo com IDs de teste SyncPay
  BILLING_CATALOG.syncpay.products["prod_mensal"] = {
    provider_product_id: "prod_mensal",
    plan: "MONTHLY",
    duration_days: 30,
    base_devices: 1,
  };
  BILLING_CATALOG.syncpay.products["prod_trimestral"] = {
    provider_product_id: "prod_trimestral",
    plan: "QUARTERLY",
    duration_days: 90,
    base_devices: 1,
  };
  BILLING_CATALOG.syncpay.products["prod_anual"] = {
    provider_product_id: "prod_anual",
    plan: "ANNUAL",
    duration_days: 365,
    base_devices: 1,
  };

  BILLING_CATALOG.syncpay.order_bumps["bump_1"] = { provider_bump_id: "bump_1", additional_devices: 1 };
  BILLING_CATALOG.syncpay.order_bumps["bump_3"] = { provider_bump_id: "bump_3", additional_devices: 3 };
  BILLING_CATALOG.syncpay.order_bumps["bump_5"] = { provider_bump_id: "bump_5", additional_devices: 5 };

  const db = new InMemorySupabaseMock();
  const core = new BillingCore(db as any);
  const caktoAdapter = new CaktoAdapter();
  const caktoSecret = "cakto_sec_test_secret_123456";

  console.log("\n--- TESTES SYNCPAY (LEGACY / REGRESSÃO) ---");

  // Teste 1: Compra mensal sem bump -> max_devices = 1
  {
    const res = await core.processEvent({
      provider: "syncpay",
      provider_event_id: "ev_01",
      event_type: "payment_approved",
      transaction_id: "tx_01",
      customer: { name: "Tester 1", email: "t1@neko.ai", phone: "11999999991" },
      product_id: "prod_mensal",
      items: [{ id: "prod_mensal", name: "Mensal", type: "product" }],
      amount: 49,
      currency: "BRL",
      occurred_at: new Date().toISOString(),
    });
    assert(res.ok && res.action_performed === "license_created", "1. SyncPay: Compra mensal sem bump criada");
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.max_devices === 1 && lic.plan === "MONTHLY", "1b. max_devices = 1");
  }

  // Teste 2: SyncPay Evento duplicado -> Idempotência
  {
    const initialLicenseCount = db.licenses.length;
    const res = await core.processEvent({
      provider: "syncpay",
      provider_event_id: "ev_01",
      event_type: "payment_approved",
      transaction_id: "tx_01_retry",
      customer: { name: "Tester 1", email: "t1@neko.ai", phone: "11999999991" },
      product_id: "prod_mensal",
      items: [{ id: "prod_mensal", name: "Mensal", type: "product" }],
      amount: 49,
      currency: "BRL",
      occurred_at: new Date().toISOString(),
    });
    assert(
      res.action_performed === "already_processed" && db.licenses.length === initialLicenseCount,
      "2. SyncPay: Evento duplicado bloqueado por idempotência"
    );
  }

  console.log("\n--- TESTES CAKTO (FASE 4 - 20 CENÁRIOS) ---");

  // IDs Oficiais Cakto
  const CAKTO_MENSAL_ID = "c6ddef32-e73d-44d6-88a3-21b376c01968";
  const CAKTO_TRIMESTRAL_ID = "0e0c7367-322d-452e-861d-26313c1bc019";
  const CAKTO_ANUAL_ID = "10257b2a-ac11-446a-97fb-8ce08bdee3b2";

  const BUMP_MENSAL_1 = "ec865e07-1622-4ff6-aac2-977c58e90cba";
  const BUMP_MENSAL_3 = "a5ea941a-1663-40e9-a2fc-48ddf40a951b";
  const BUMP_MENSAL_5 = "b6fcbbc5-f3ef-4a0e-a766-9d9f82349b94";

  const BUMP_TRI_1 = "e1bd85a1-f786-40d7-999a-482178e8b8d3";
  const BUMP_TRI_3 = "bbed949c-43ee-4c58-9a33-21d164d2d9eb";
  const BUMP_TRI_5 = "14e5a056-9524-4f75-a408-e910fb758201";

  const BUMP_ANUAL_1 = "fcffaedd-0819-4de7-80e8-0e15a95b8324";
  const BUMP_ANUAL_3 = "de3ceada-176d-491c-a5d3-390ca37e727f";
  const BUMP_ANUAL_5 = "465d6d9d-e035-44f0-8578-5998a26e1627";

  // 1. Cakto: Mensal Base sem Bump -> max_devices = 1 (MONTHLY)
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_01",
        refId: "cakto_ref_01",
        product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal", price: 49.0 },
        customer: { name: "Cliente Cakto Mensal", email: "mensal@cakto.test", phone: "+5511911111111" },
        amount: 49.0,
      },
    };

    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    assert(res.ok && res.action_performed === "license_created", "1. Cakto: Mensal Base criado com sucesso");
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.max_devices === 1 && lic.plan === "MONTHLY", "1b. Cakto: Mensal Base max_devices = 1, plan = MONTHLY");
  }

  // 2. Cakto: Trimestral Base -> plan = QUARTERLY, max_devices = 1
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_02",
        refId: "cakto_ref_02",
        product: { id: CAKTO_TRIMESTRAL_ID, name: "NekoAI Trimestral", price: 129.0 },
        customer: { name: "Cliente Cakto Trimestral", email: "tri@cakto.test", phone: "+5511922222222" },
        amount: 129.0,
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.plan === "QUARTERLY" && lic.max_devices === 1, "2. Cakto: Trimestral Base plan = QUARTERLY, max_devices = 1");
  }

  // 3. Cakto: Anual Base -> plan = ANNUAL, max_devices = 1
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_03",
        refId: "cakto_ref_03",
        product: { id: CAKTO_ANUAL_ID, name: "NekoAI Anual", price: 347.0 },
        customer: { name: "Cliente Cakto Anual", email: "anual@cakto.test", phone: "+5511933333333" },
        amount: 347.0,
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.plan === "ANNUAL" && lic.max_devices === 1, "3. Cakto: Anual Base plan = ANNUAL, max_devices = 1");
  }

  // 4. Cakto: Mensal + Bump +1 -> max_devices = 2
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_bump_1",
        refId: "cakto_ref_bump_1",
        product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal", price: 49.0 },
        order_bumps: [{ id: BUMP_MENSAL_1, name: "Bump +1", price: 15.0 }],
        customer: { name: "Cakto Bump 1", email: "b1@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.max_devices === 2, "4. Cakto: Mensal + Bump +1 -> max_devices = 2");
  }

  // 5. Cakto: Mensal + Bump +3 -> max_devices = 4
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_bump_3",
        refId: "cakto_ref_bump_3",
        product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal", price: 49.0 },
        order_bumps: [{ id: BUMP_MENSAL_3, name: "Bump +3", price: 45.0 }],
        customer: { name: "Cakto Bump 3", email: "b3@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.max_devices === 4, "5. Cakto: Mensal + Bump +3 -> max_devices = 4");
  }

  // 6. Cakto: Mensal + Bump +5 -> max_devices = 6
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_bump_5",
        refId: "cakto_ref_bump_5",
        product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal", price: 49.0 },
        order_bumps: [{ id: BUMP_MENSAL_5, name: "Bump +5", price: 60.0 }],
        customer: { name: "Cakto Bump 5", email: "b5@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(lic && lic.max_devices === 6, "6. Cakto: Mensal + Bump +5 -> max_devices = 6");
  }

  // 7. Cakto: Trimestral + Bumps (+1, +3, +5)
  {
    const p1 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "tri_b1",
        product: { id: CAKTO_TRIMESTRAL_ID },
        order_bumps: [{ id: BUMP_TRI_1 }],
        customer: { email: "tri_b1@test.com" },
      },
    };
    const p3 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "tri_b3",
        product: { id: CAKTO_TRIMESTRAL_ID },
        order_bumps: [{ id: BUMP_TRI_3 }],
        customer: { email: "tri_b3@test.com" },
      },
    };
    const p5 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "tri_b5",
        product: { id: CAKTO_TRIMESTRAL_ID },
        order_bumps: [{ id: BUMP_TRI_5 }],
        customer: { email: "tri_b5@test.com" },
      },
    };

    const r1 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p1)));
    const r3 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p3)));
    const r5 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p5)));

    const l1 = db.licenses.find((l) => l.id === r1.license_id);
    const l3 = db.licenses.find((l) => l.id === r3.license_id);
    const l5 = db.licenses.find((l) => l.id === r5.license_id);

    assert(
      l1.max_devices === 2 && l3.max_devices === 4 && l5.max_devices === 6,
      "7. Cakto: Trimestral Bumps (+1, +3, +5) -> max_devices 2, 4, 6"
    );
  }

  // 8. Cakto: Anual + Bumps (+1, +3, +5)
  {
    const p1 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "anu_b1",
        product: { id: CAKTO_ANUAL_ID },
        order_bumps: [{ id: BUMP_ANUAL_1 }],
        customer: { email: "anu_b1@test.com" },
      },
    };
    const p3 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "anu_b3",
        product: { id: CAKTO_ANUAL_ID },
        order_bumps: [{ id: BUMP_ANUAL_3 }],
        customer: { email: "anu_b3@test.com" },
      },
    };
    const p5 = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "anu_b5",
        product: { id: CAKTO_ANUAL_ID },
        order_bumps: [{ id: BUMP_ANUAL_5 }],
        customer: { email: "anu_b5@test.com" },
      },
    };

    const r1 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p1)));
    const r3 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p3)));
    const r5 = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(p5)));

    const l1 = db.licenses.find((l) => l.id === r1.license_id);
    const l3 = db.licenses.find((l) => l.id === r3.license_id);
    const l5 = db.licenses.find((l) => l.id === r5.license_id);

    assert(
      l1.max_devices === 2 && l3.max_devices === 4 && l5.max_devices === 6,
      "8. Cakto: Anual Bumps (+1, +3, +5) -> max_devices 2, 4, 6"
    );
  }

  // 9. Cakto: purchase_approved com Assinatura (1º Ciclo) -> subscription_created
  let caktoSubLicenseId = "";
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_sub_evt_init",
        refId: "cakto_order_sub_01",
        subscription: { id: "sub_cakto_9999", status: "active", recurrence_period: 30 },
        product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal Assinatura" },
        customer: { name: "Assinante Cakto", email: "assinante@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    assert(norm.event_type === "subscription_created", "9a. Cakto: purchase_approved com subscription normalizado para subscription_created");

    const res = await core.processEvent(norm);
    caktoSubLicenseId = res.license_id!;
    const subRecord = db.billing_subscriptions.find((s) => s.provider_subscription_id === "sub_cakto_9999");
    assert(res.ok && !!subRecord, "9b. Cakto: Licença criada e vinculada na tabela billing_subscriptions");
  }

  // 10. Cakto: subscription_renewed -> Estende expiração mantendo mesmo license_id
  {
    const licBefore = db.licenses.find((l) => l.id === caktoSubLicenseId);
    const expBefore = new Date(licBefore.expires_at).getTime();

    const payload = {
      secret: caktoSecret,
      event: "subscription_renewed",
      data: {
        id: "cakto_sub_renew_evt",
        refId: "cakto_order_renew_01",
        subscription: { id: "sub_cakto_9999", status: "active" },
        customer: { email: "assinante@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const licAfter = db.licenses.find((l) => l.id === caktoSubLicenseId);
    const expAfter = new Date(licAfter.expires_at).getTime();

    assert(
      res.action_performed === "license_renewed" && res.license_id === caktoSubLicenseId && expAfter > expBefore,
      "10. Cakto: subscription_renewed estendeu expiração mantendo mesmo license_id"
    );
  }

  // 11. Cakto: subscription_canceled -> Mantém licença ativa até expires_at
  {
    const payload = {
      secret: caktoSecret,
      event: "subscription_canceled",
      data: {
        id: "cakto_sub_cancel_evt",
        subscription: { id: "sub_cakto_9999", status: "canceled" },
        customer: { email: "assinante@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === caktoSubLicenseId);
    const sub = db.billing_subscriptions.find((s) => s.provider_subscription_id === "sub_cakto_9999");
    assert(
      res.action_performed === "status_updated" && lic.status === "active" && sub.status === "cancelled",
      "11. Cakto: subscription_canceled manteve licença active e marcou subscription cancelled"
    );
  }

  // 12. Cakto: refund -> Revogação imediata da licença
  {
    const payload = {
      secret: caktoSecret,
      event: "refund",
      data: {
        id: "cakto_refund_evt",
        subscription: { id: "sub_cakto_9999" },
        customer: { email: "assinante@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === caktoSubLicenseId);
    assert(
      res.action_performed === "license_revoked" && lic.status === "revoked",
      "12. Cakto: refund revogou licença imediatamente"
    );
  }

  // 13. Cakto: chargeback -> Revogação imediata da licença
  {
    // Cria uma licença avulsa para testar chargeback
    const pAvulsa = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_avulsa_chargeback_init",
        product: { id: CAKTO_MENSAL_ID },
        customer: { email: "chargeback_user@cakto.test" },
      },
    };
    const rInit = await core.processEvent(await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pAvulsa)));

    const pChargeback = {
      secret: caktoSecret,
      event: "chargeback",
      data: {
        id: "cakto_chargeback_evt",
        customer: { email: "chargeback_user@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pChargeback));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === rInit.license_id);
    assert(
      res.action_performed === "license_revoked" && lic.status === "revoked",
      "13. Cakto: chargeback revogou licença imediatamente"
    );
  }

  // 14. Cakto: purchase_refused -> Log/Sem alteração
  {
    const payload = {
      secret: caktoSecret,
      event: "purchase_refused",
      data: {
        id: "cakto_refused_evt",
        product: { id: CAKTO_MENSAL_ID },
        customer: { email: "refused@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payload));
    const res = await core.processEvent(norm);
    assert(
      norm.event_type === "payment_failed" && res.action_performed === "ignored",
      "14. Cakto: purchase_refused ignorado sem gerar efeitos colaterais"
    );
  }

  // 15, 16, 17: Validação do Secret Cakto (Correto, Ausente, Incorreto)
  {
    const validBody = JSON.stringify({ secret: caktoSecret, event: "purchase_approved" });
    const invalidBody = JSON.stringify({ secret: "wrong_secret_123", event: "purchase_approved" });
    const missingSecretBody = JSON.stringify({ event: "purchase_approved" });

    const isValOk = await caktoAdapter.verifyWebhookSignature(new Headers(), validBody, caktoSecret);
    const isValWrong = await caktoAdapter.verifyWebhookSignature(new Headers(), invalidBody, caktoSecret);
    const isValMissing = await caktoAdapter.verifyWebhookSignature(new Headers(), missingSecretBody, caktoSecret);

    assert(isValOk === true, "15. Cakto: Secret correto aceito");
    assert(isValWrong === false, "16. Cakto: Secret incorreto rejeitado");
    assert(isValMissing === false, "17. Cakto: Secret ausente rejeitado");
  }

  // 18. Cakto: Idempotência de Evento Duplicado
  {
    const initialCount = db.licenses.length;
    const pDuplicate = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "cakto_evt_01", // mesmo id do teste 1
        product: { id: CAKTO_MENSAL_ID },
        customer: { email: "mensal@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pDuplicate));
    const res = await core.processEvent(norm);
    assert(
      res.action_performed === "already_processed" && db.licenses.length === initialCount,
      "18. Cakto: Idempotência de evento duplicado respeitada"
    );
  }

  // 19. Cakto: Renovação sem assinatura existente -> Não cria licença silenciosamente
  {
    const pOrphanRenew = {
      secret: caktoSecret,
      event: "subscription_renewed",
      data: {
        id: "orphan_renew_evt",
        subscription: { id: "sub_nao_cadastrada_9999" },
        customer: { email: "orphan@cakto.test" },
      },
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pOrphanRenew));
    const res = await core.processEvent(norm);
    assert(
      res.ok === false && res.action_performed === "ignored",
      "19. Cakto: Renovação com subscription inexistente rejeitada com segurança"
    );
  }

  // 20. Cakto: Produto desconhecido & Order Bump desconhecido
  {
    const pUnknownProd = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "unknown_prod_evt",
        product: { id: "prod_inexistente_uuid" },
        customer: { email: "unknown@cakto.test" },
      },
    };
    const normProd = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pUnknownProd));
    const resProd = await core.processEvent(normProd);
    assert(
      resProd.ok === false && resProd.error_code === "PRODUCT_NOT_RECOGNIZED",
      "20a. Cakto: Produto desconhecido rejeitado com erro explícito"
    );

    const pUnknownBump = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: {
        id: "unknown_bump_evt",
        product: { id: CAKTO_MENSAL_ID },
        order_bumps: [{ id: "bump_fake_uuid" }],
        customer: { email: "bump_fake@cakto.test" },
      },
    };
    const normBump = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(pUnknownBump));
    const resBump = await core.processEvent(normBump);
    const licBump = db.licenses.find((l) => l.id === resBump.license_id);
    assert(
      resBump.ok === true && licBump.max_devices === 1,
      "20b. Cakto: Bump desconhecido ignorado com segurança mantendo base = 1"
    );
  }

  console.log("\n--- TESTES CAKTO MODO AGRUPADO (ARRAY) ---");

  // 21. Cakto Agrupado: data como Array com apenas produto principal (offer_type = main)
  {
    const payloadArraySingle = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: [
        {
          id: "cakto_arr_evt_01",
          refId: "cakto_arr_ref_01",
          offer_type: "main",
          product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal" },
          customer: { name: "Array User", email: "array1@cakto.test", docNumber: "12345678900" },
          amount: 49.0,
        },
      ],
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadArraySingle));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(
      res.ok && lic && lic.max_devices === 1 && lic.plan === "MONTHLY",
      "21. Cakto Agrupado: Array com produto principal único cria licença com max_devices = 1"
    );
  }

  // 22. Cakto Agrupado: data como Array com produto principal + 1 Order Bump
  {
    const payloadArrayWithBump = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: [
        {
          id: "cakto_arr_evt_02",
          refId: "cakto_arr_ref_02",
          offer_type: "main",
          product: { id: CAKTO_MENSAL_ID, name: "NekoAI Mensal" },
          customer: { name: "Array Bump User", email: "array_bump1@cakto.test" },
          amount: 49.0,
        },
        {
          id: "cakto_bump_item_01",
          refId: "cakto_arr_ref_02_b1",
          offer_type: "orderbump",
          product: { id: BUMP_MENSAL_1, name: "Bump +1" },
          amount: 15.0,
        },
      ],
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadArrayWithBump));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(
      res.ok && lic && lic.max_devices === 2,
      "22. Cakto Agrupado: Array com main + 1 bump gera UMA única licença com max_devices = 2"
    );
  }

  // 23. Cakto Agrupado: data como Array com múltiplos Order Bumps
  {
    const payloadArrayMultiBumps = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: [
        {
          id: "cakto_arr_evt_03",
          refId: "cakto_arr_ref_03",
          offer_type: "main",
          product: { id: CAKTO_TRIMESTRAL_ID, name: "NekoAI Trimestral" },
          customer: { name: "Array Multi Bump User", email: "array_multi@cakto.test" },
          amount: 129.0,
        },
        {
          offer_type: "orderbump",
          product: { id: BUMP_TRI_1, name: "Bump +1" },
          amount: 29.0,
        },
        {
          offer_type: "orderbump",
          product: { id: BUMP_TRI_3, name: "Bump +3" },
          amount: 59.0,
        },
      ],
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadArrayMultiBumps));
    const res = await core.processEvent(norm);
    const lic = db.licenses.find((l) => l.id === res.license_id);
    assert(
      res.ok && lic && lic.max_devices === 5, // 1 base + 1 bump1 + 3 bump3 = 5
      "23. Cakto Agrupado: Array com múltiplos bumps soma corretamente (1 + 1 + 3 = 5)"
    );
  }

  // 24. Cakto Agrupado: Payload inválido sem id/refId (Rejeição estrita sem randomUUID)
  {
    let rejectedNoId = false;
    try {
      const payloadNoId = {
        secret: caktoSecret,
        event: "purchase_approved",
        data: [
          {
            offer_type: "main",
            product: { id: CAKTO_MENSAL_ID },
            customer: { email: "no_id@cakto.test" },
          },
        ],
      };
      await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadNoId));
    } catch {
      rejectedNoId = true;
    }
    assert(rejectedNoId === true, "24. Cakto Agrupado: Payload sem id e sem refId rejeitado com erro estrito");
  }

  // 25. Cakto Agrupado: Idempotência de compra agrupada reenviada
  {
    const initialLicenseCount = db.licenses.length;
    const payloadRetry = {
      secret: caktoSecret,
      event: "purchase_approved",
      data: [
        {
          id: "cakto_arr_evt_02", // mesmo id do teste 22
          refId: "cakto_arr_ref_02",
          offer_type: "main",
          product: { id: CAKTO_MENSAL_ID },
          customer: { email: "array_bump1@cakto.test" },
        },
        {
          offer_type: "orderbump",
          product: { id: BUMP_MENSAL_1 },
        },
      ],
    };
    const norm = await caktoAdapter.parseAndNormalize(new Headers(), JSON.stringify(payloadRetry));
    const res = await core.processEvent(norm);
    assert(
      res.action_performed === "already_processed" && db.licenses.length === initialLicenseCount,
      "25. Cakto Agrupado: Reenvio de compra agrupada bloqueado por idempotência sem duplicar licença"
    );
  }

  console.log(`\n=== RESUMO FINAL: ${passed} PASSOU, ${failed} FALHOU ===`);
}

runBillingTests().catch(console.error);
