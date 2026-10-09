// supabase/functions/_shared/pricing/admin-pricing.ts
// Serviço centralizado e resiliente de resolução de Pricing Administrativo NekoAI

export interface PlanPricing {
  neko_cost: number;
  suggested_resale_price: number;
}

export interface AdminPricingMap {
  MONTHLY: PlanPricing;
  QUARTERLY: PlanPricing;
  ANNUAL: PlanPricing;
}

/**
 * Fallback canônico oficial.
 * Utilizado quando a tabela admin_settings ainda não existir,
 * estiver indisponível ou retornar valores corrompidos.
 */
export const FALLBACK_ADMIN_PRICING: AdminPricingMap = {
  MONTHLY: { neko_cost: 39.00, suggested_resale_price: 79.00 },
  QUARTERLY: { neko_cost: 69.00, suggested_resale_price: 149.00 },
  ANNUAL: { neko_cost: 197.00, suggested_resale_price: 397.00 },
};

/**
 * Obtém a tabela oficial de preços administrativos a partir de admin_settings.
 * Aplica validação estrita de valores positivos e regra de margem: resale_price >= neko_cost.
 */
export async function getOfficialPricing(supabaseAdmin: any): Promise<AdminPricingMap> {
  if (!supabaseAdmin) {
    return { ...FALLBACK_ADMIN_PRICING };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("admin_settings")
      .select("value")
      .eq("key", "pricing")
      .maybeSingle();

    if (error || !data || !data.value || !data.value.plans) {
      return { ...FALLBACK_ADMIN_PRICING };
    }

    const plans = data.value.plans;
    const resolved: AdminPricingMap = {
      MONTHLY: resolvePlanPricing(plans.MONTHLY, FALLBACK_ADMIN_PRICING.MONTHLY),
      QUARTERLY: resolvePlanPricing(plans.QUARTERLY, FALLBACK_ADMIN_PRICING.QUARTERLY),
      ANNUAL: resolvePlanPricing(plans.ANNUAL, FALLBACK_ADMIN_PRICING.ANNUAL),
    };

    return resolved;
  } catch (err: any) {
    console.warn("[admin-pricing] Falha ao consultar admin_settings, aplicando fallback:", err?.message);
    return { ...FALLBACK_ADMIN_PRICING };
  }
}

function resolvePlanPricing(candidate: any, fallback: PlanPricing): PlanPricing {
  if (!candidate || typeof candidate !== "object") {
    return { ...fallback };
  }

  const nekoCost = Number(candidate.neko_cost);
  const resalePrice = Number(candidate.suggested_resale_price);

  // Validação: valores numéricos válidos e estritamente positivos
  if (isNaN(nekoCost) || nekoCost <= 0 || isNaN(resalePrice) || resalePrice <= 0) {
    return { ...fallback };
  }

  // Validação de integridade financeira: preço de revenda deve cobrir o custo NekoAI
  if (resalePrice < nekoCost) {
    return { ...fallback };
  }

  return {
    neko_cost: Number(nekoCost.toFixed(2)),
    suggested_resale_price: Number(resalePrice.toFixed(2)),
  };
}
