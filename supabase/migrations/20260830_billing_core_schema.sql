-- ============================================================================
-- NEKOAI BILLING SYSTEM - MIGRATION v1.4.0 (PROPOSTA LOCAL / STAGING)
-- GATEWAY-AGNOSTIC BILLING, IDEMPOTENCY & RECURRING SUBSCRIPTIONS
-- ============================================================================

-- 1. ADICIONAR COLUNAS DE BILLING E CHAVE CRIPTOGRAFADA NA TABELA LICENSES (SE NÃO EXISTIREM)
ALTER TABLE public.licenses
    ADD COLUMN IF NOT EXISTS provider VARCHAR(32) DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(128) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS provider_subscription_id VARCHAR(128) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS encrypted_key TEXT DEFAULT NULL;

-- Índices de consulta rápida por provider e assinatura
CREATE INDEX IF NOT EXISTS idx_licenses_provider_sub 
    ON public.licenses(provider, provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_licenses_provider_cust 
    ON public.licenses(provider, provider_customer_id);

-- 2. TABELA DE IDEMPOTÊNCIA DE EVENTOS DE BILLING (DEDUPLICAÇÃO E LOCK)
CREATE TABLE IF NOT EXISTS public.billing_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(32) NOT NULL,
    provider_event_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'processing', -- 'processing', 'completed', 'failed'
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_billing_idempotency UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_idempotency_lookup 
    ON public.billing_idempotency(provider, provider_event_id);

-- 3. TABELA DE VÍNCULO DE ASSINATURAS RECORRENTES (SUBSCRIPTIONS)
CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id UUID NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    provider_subscription_id VARCHAR(128) NOT NULL,
    provider_customer_id VARCHAR(128) DEFAULT NULL,
    plan VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active', 'overdue', 'suspended', 'cancelled'
    next_charge_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_billing_subscription_provider UNIQUE (provider, provider_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_lookup 
    ON public.billing_subscriptions(provider, provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_license 
    ON public.billing_subscriptions(license_id);
