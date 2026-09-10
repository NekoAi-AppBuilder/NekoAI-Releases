// supabase/functions/_shared/billing/catalog.ts
// Configuração centralizada e imutável do catálogo de produtos e order bumps

import { BillingCatalogConfig, BillingProvider } from "./types.ts";

/**
 * Catálogo centralizado de mapeamento de IDs estáveis por Provider.
 * Os IDs devem ser os UUIDs ou Identificadores públicos cadastrados no dashboard de cada gateway.
 */
export const BILLING_CATALOG: Record<BillingProvider, BillingCatalogConfig> = {
  cakto: {
    products: {
      // Mensal Base (R$49 / 30 dias / 1 dispositivo)
      "c6ddef32-e73d-44d6-88a3-21b376c01968": {
        provider_product_id: "c6ddef32-e73d-44d6-88a3-21b376c01968",
        plan: "MONTHLY",
        duration_days: 30,
        base_devices: 1,
      },
      // Trimestral Base (R$129 / 90 dias / 1 dispositivo)
      "0e0c7367-322d-452e-861d-26313c1bc019": {
        provider_product_id: "0e0c7367-322d-452e-861d-26313c1bc019",
        plan: "QUARTERLY",
        duration_days: 90,
        base_devices: 1,
      },
      // Anual Base (R$347 / 365 dias / 1 dispositivo)
      "10257b2a-ac11-446a-97fb-8ce08bdee3b2": {
        provider_product_id: "10257b2a-ac11-446a-97fb-8ce08bdee3b2",
        plan: "ANNUAL",
        duration_days: 365,
        base_devices: 1,
      },
    },
    order_bumps: {
      // Mensal - Order Bumps
      "ec865e07-1622-4ff6-aac2-977c58e90cba": {
        provider_bump_id: "ec865e07-1622-4ff6-aac2-977c58e90cba",
        additional_devices: 1,
      },
      "a5ea941a-1663-40e9-a2fc-48ddf40a951b": {
        provider_bump_id: "a5ea941a-1663-40e9-a2fc-48ddf40a951b",
        additional_devices: 3,
      },
      "b6fcbbc5-f3ef-4a0e-a766-9d9f82349b94": {
        provider_bump_id: "b6fcbbc5-f3ef-4a0e-a766-9d9f82349b94",
        additional_devices: 5,
      },

      // Trimestral - Order Bumps
      "e1bd85a1-f786-40d7-999a-482178e8b8d3": {
        provider_bump_id: "e1bd85a1-f786-40d7-999a-482178e8b8d3",
        additional_devices: 1,
      },
      "bbed949c-43ee-4c58-9a33-21d164d2d9eb": {
        provider_bump_id: "bbed949c-43ee-4c58-9a33-21d164d2d9eb",
        additional_devices: 3,
      },
      "14e5a056-9524-4f75-a408-e910fb758201": {
        provider_bump_id: "14e5a056-9524-4f75-a408-e910fb758201",
        additional_devices: 5,
      },

      // Anual - Order Bumps
      "fcffaedd-0819-4de7-80e8-0e15a95b8324": {
        provider_bump_id: "fcffaedd-0819-4de7-80e8-0e15a95b8324",
        additional_devices: 1,
      },
      "de3ceada-176d-491c-a5d3-390ca37e727f": {
        provider_bump_id: "de3ceada-176d-491c-a5d3-390ca37e727f",
        additional_devices: 3,
      },
      "465d6d9d-e035-44f0-8578-5998a26e1627": {
        provider_bump_id: "465d6d9d-e035-44f0-8578-5998a26e1627",
        additional_devices: 5,
      },
    },
  },

  syncpay: {
    products: {
      "SYNCPAY_PROD_MENSAL_ID_PLACEHOLDER": {
        provider_product_id: "SYNCPAY_PROD_MENSAL_ID_PLACEHOLDER",
        plan: "MONTHLY",
        duration_days: 30,
        base_devices: 1,
      },
      "SYNCPAY_PROD_TRIMESTRAL_ID_PLACEHOLDER": {
        provider_product_id: "SYNCPAY_PROD_TRIMESTRAL_ID_PLACEHOLDER",
        plan: "QUARTERLY",
        duration_days: 90,
        base_devices: 1,
      },
      "SYNCPAY_PROD_ANUAL_ID_PLACEHOLDER": {
        provider_product_id: "SYNCPAY_PROD_ANUAL_ID_PLACEHOLDER",
        plan: "ANNUAL",
        duration_days: 365,
        base_devices: 1,
      },
    },
    order_bumps: {
      "SYNCPAY_BUMP_PLUS1_ID_PLACEHOLDER": {
        provider_bump_id: "SYNCPAY_BUMP_PLUS1_ID_PLACEHOLDER",
        additional_devices: 1,
      },
      "SYNCPAY_BUMP_PLUS3_ID_PLACEHOLDER": {
        provider_bump_id: "SYNCPAY_BUMP_PLUS3_ID_PLACEHOLDER",
        additional_devices: 3,
      },
      "SYNCPAY_BUMP_PLUS5_ID_PLACEHOLDER": {
        provider_bump_id: "SYNCPAY_BUMP_PLUS5_ID_PLACEHOLDER",
        additional_devices: 5,
      },
    },
  },

  stripe: {
    products: {},
    order_bumps: {},
  },

  manual: {
    products: {},
    order_bumps: {},
  },
};
