-- ============================================================================
-- NEKOAI RESELLER MODULE - RENEWALS FOUNDATION SCHEMA & ATOMIC OPERATION
-- Migration: 20261007_reseller_license_renewals_schema.sql
-- Status: LOCAL ONLY — NÃO EXECUTADA NO SUPABASE REMOTO (CONFORME REGRAS ABSOLUTAS)
-- Author: Senior Engineering Team
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTENSÃO DA TABELA PUBLIC.RESELLER_SALES (CAMPO sale_type)
-- Suporta vendas de novas licenças ('NEW_LICENSE') e renovações ('RENEWAL').
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'reseller_sales'
          AND column_name = 'sale_type'
    ) THEN
        ALTER TABLE public.reseller_sales
            ADD COLUMN sale_type VARCHAR(32) NOT NULL DEFAULT 'NEW_LICENSE';
    END IF;
END $$;

-- Backfill explícito e seguro para quaisquer registros legados
UPDATE public.reseller_sales
SET sale_type = 'NEW_LICENSE'
WHERE sale_type IS NULL;

-- Restrição de integridade para os tipos permitidos em sale_type
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_reseller_sales_sale_type'
    ) THEN
        ALTER TABLE public.reseller_sales
            ADD CONSTRAINT chk_reseller_sales_sale_type
            CHECK (sale_type IN ('NEW_LICENSE', 'RENEWAL'));
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. SALVAGUARDA DE MULTIPLICIDADE EM RESELLER_SALES.LICENSE_ID
-- Confirmação técnica: a coluna license_id NÃO é UNIQUE, permitindo relação 1:N
-- (1 licença referenciada pela venda de criação e por N vendas de renovação).
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 3. EXTENSÃO DA TABELA PUBLIC.LICENSES (METADADOS DE RENOVAÇÃO)
-- renewed_at: carimbo de data/hora da última renovação
-- renewal_count: contador acumulativo de renovações realizadas
-- ----------------------------------------------------------------------------
ALTER TABLE public.licenses
    ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS renewal_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_licenses_renewal_count_non_negative'
    ) THEN
        ALTER TABLE public.licenses
            ADD CONSTRAINT chk_licenses_renewal_count_non_negative
            CHECK (renewal_count >= 0);
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. ÍNDICES DE PERFORMANCE E CONSULTA
-- Otimiza listagens de renovações por licença, por revendedor e checagens de expiração.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reseller_sales_license_sale_type
    ON public.reseller_sales(license_id, sale_type);

CREATE INDEX IF NOT EXISTS idx_reseller_sales_reseller_sale_type
    ON public.reseller_sales(reseller_id, sale_type);

CREATE INDEX IF NOT EXISTS idx_licenses_reseller_expires
    ON public.licenses(reseller_id, expires_at);

-- Índice parcial exclusivo de proteção contra concorrência:
-- Impede criação simultânea de duas intenções PIX pendentes/pagas para a mesma licença.
-- Permite ilimitadas renovações históricas ('license_delivered') e reabertura imediata se ('expired', 'cancelled').
CREATE UNIQUE INDEX IF NOT EXISTS uq_reseller_sales_active_renewal
    ON public.reseller_sales(license_id)
    WHERE (sale_type = 'RENEWAL' AND status IN ('pending', 'paid'));

-- ----------------------------------------------------------------------------
-- 5. FUNÇÃO ATÔMICA TRANSACIONAL: fn_renew_reseller_license
-- Executa a renovação completa de forma atômica no banco de dados:
--   - Fonte única de autoridade: public.reseller_sales (license_id, plan, sale_type)
--   - Assinatura estrita: (p_sale_id, p_reseller_id, p_ip_address, p_user_agent)
--   - SELECT FOR UPDATE em reseller_sales e licenses
--   - Validação estrita de status: exclusivamente status 'paid'
--   - Validação estrita de posse (reseller_id da venda e da licença)
--   - Validação de regras de negócio (proibido TEST, proibido revoked)
--   - Idempotência total (se já entregue, retorna sem duplicar dias/contador/evento)
--   - Captura explícita de v_previous_plan e v_previous_expires_at antes do UPDATE
--   - Cálculo contínuo (se ativa: expires_at + prazo; se expirada: now() + prazo)
--   - Auditoria em license_events
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_renew_reseller_license(
    p_sale_id UUID,
    p_reseller_id UUID,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sale RECORD;
    v_license RECORD;
    v_interval INTERVAL;
    v_days_added INT;
    v_previous_plan VARCHAR(32);
    v_previous_expires_at TIMESTAMPTZ;
    v_new_expires_at TIMESTAMPTZ;
    v_is_expired BOOLEAN;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Trava e validação da venda (SELECT FOR UPDATE) — Fonte de Autoridade
    SELECT * INTO v_sale
    FROM public.reseller_sales
    WHERE id = p_sale_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'SALE_NOT_FOUND',
            'message', 'Venda não encontrada.'
        );
    END IF;

    -- 2. Validação de propriedade da venda pelo revendedor autenticado
    IF v_sale.reseller_id != p_reseller_id THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'FORBIDDEN_RESELLER_MISMATCH',
            'message', 'Venda não pertence ao revendedor autenticado.'
        );
    END IF;

    -- 3. Validação do tipo de venda (deve ser RENEWAL)
    IF v_sale.sale_type != 'RENEWAL' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'INVALID_SALE_TYPE',
            'message', 'A venda informada não é do tipo RENEWAL.'
        );
    END IF;

    -- 4. Validação de vinculação de licença na venda
    IF v_sale.license_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'SALE_MISSING_LICENSE_ID',
            'message', 'A venda de renovação não possui licença vinculada.'
        );
    END IF;

    -- 5. Idempotência estrita: se a venda já foi entregue
    IF v_sale.status = 'license_delivered' THEN
        SELECT * INTO v_license FROM public.licenses WHERE id = v_sale.license_id;
        RETURN jsonb_build_object(
            'ok', true,
            'idempotent', true,
            'sale_id', v_sale.id,
            'license_id', v_license.id,
            'plan', v_license.plan,
            'expires_at', v_license.expires_at,
            'renewal_count', v_license.renewal_count,
            'message', 'Renovação já havia sido processada com sucesso anteriormente.'
        );
    END IF;

    -- 6. Validação estrita de status: exclusivamente status 'paid'
    IF v_sale.status != 'paid' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'SALE_NOT_PAID',
            'message', 'A venda precisa estar com pagamento confirmado (status paid) para renovar a licença.'
        );
    END IF;

    -- 7. Validação e mapeamento do plano a partir de v_sale.plan (Fonte de Autoridade)
    IF v_sale.plan = 'MONTHLY' THEN
        v_interval := INTERVAL '30 days';
        v_days_added := 30;
    ELSIF v_sale.plan = 'QUARTERLY' THEN
        v_interval := INTERVAL '90 days';
        v_days_added := 90;
    ELSIF v_sale.plan = 'ANNUAL' THEN
        v_interval := INTERVAL '365 days';
        v_days_added := 365;
    ELSE
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'INVALID_PLAN',
            'message', 'Plano da venda inválido para renovação. Valores permitidos: MONTHLY, QUARTERLY, ANNUAL.'
        );
    END IF;

    -- 8. Trava e validação da licença existente vinculada (SELECT FOR UPDATE)
    SELECT * INTO v_license
    FROM public.licenses
    WHERE id = v_sale.license_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'LICENSE_NOT_FOUND',
            'message', 'Licença vinculada à venda não encontrada.'
        );
    END IF;

    -- 9. Validação de isolamento: licença deve pertencer ao revendedor autenticado
    IF v_license.reseller_id IS NULL OR v_license.reseller_id != p_reseller_id THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'LICENSE_RESELLER_MISMATCH',
            'message', 'A licença vinculada não pertence ao seu catálogo de revendedor.'
        );
    END IF;

    -- 10. Validação de licença TEST (proibido renovar teste gratuito)
    IF v_license.license_type = 'TEST' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'CANNOT_RENEW_TEST_LICENSE',
            'message', 'Licenças de teste gratuitas não podem ser renovadas comercialmente.'
        );
    END IF;

    -- 11. Validação de licença revogada (proibido renovar licença revogada)
    IF v_license.status = 'revoked' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'CANNOT_RENEW_REVOKED_LICENSE',
            'message', 'Licenças revogadas não podem ser renovadas.'
        );
    END IF;

    -- 12. Captura explícita de dados anteriores antes do UPDATE
    v_previous_plan := v_license.plan;
    v_previous_expires_at := v_license.expires_at;
    v_is_expired := (v_previous_expires_at <= v_now);

    -- 13. Cálculo da nova expiração (extensão contínua ou reinício a partir de now)
    IF v_is_expired THEN
        v_new_expires_at := v_now + v_interval;
    ELSE
        v_new_expires_at := v_previous_expires_at + v_interval;
    END IF;

    -- 14. Atualização atômica da licença (mantém intactos key_hash, key_mask, encrypted_key, max_devices)
    UPDATE public.licenses
    SET status = 'active',
        plan = v_sale.plan,
        expires_at = v_new_expires_at,
        renewed_at = v_now,
        renewal_count = COALESCE(renewal_count, 0) + 1,
        updated_at = v_now
    WHERE id = v_license.id;

    -- 15. Atualização atômica da venda em reseller_sales
    UPDATE public.reseller_sales
    SET status = 'license_delivered',
        updated_at = v_now
    WHERE id = v_sale.id;

    -- 16. Registro de auditoria em license_events
    INSERT INTO public.license_events (
        license_id,
        device_id,
        event_type,
        ip_address,
        user_agent,
        metadata
    ) VALUES (
        v_license.id,
        '00000000000000000000000000000000',
        'renew',
        p_ip_address,
        p_user_agent,
        jsonb_build_object(
            'action', 'renew',
            'source', 'reseller_renewal_flow',
            'sale_id', v_sale.id,
            'reseller_id', p_reseller_id,
            'previous_expires_at', v_previous_expires_at,
            'new_expires_at', v_new_expires_at,
            'previous_plan', v_previous_plan,
            'new_plan', v_sale.plan,
            'days_added', v_days_added,
            'client_type', 'existing',
            'is_expired_at_renewal', v_is_expired
        )
    );

    -- 17. Retorno consolidado com sucesso
    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'sale_id', v_sale.id,
        'license_id', v_license.id,
        'key_mask', v_license.key_mask,
        'previous_expires_at', v_previous_expires_at,
        'new_expires_at', v_new_expires_at,
        'previous_plan', v_previous_plan,
        'new_plan', v_sale.plan,
        'days_added', v_days_added,
        'renewal_count', COALESCE(v_license.renewal_count, 0) + 1,
        'is_expired_at_renewal', v_is_expired
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. PERMISSÕES DE EXECUÇÃO
-- Apenas service_role pode invocar a função fn_renew_reseller_license diretamente
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_renew_reseller_license(UUID, UUID, INET, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_renew_reseller_license(UUID, UUID, INET, TEXT) TO service_role;
