-- ============================================================================
-- NEKOAI RESELLER MODULE - CORE SCHEMA & RLS HARDENING MIGRATION (FASE 3.1)
-- Environment: PROD / DEV READY
-- ============================================================================

-- 1. TABELA PUBLIC.RESELLERS
CREATE TABLE IF NOT EXISTS public.resellers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    name VARCHAR(128) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(32) DEFAULT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. TABELA PUBLIC.RESELLER_PRICE_SETTINGS
CREATE TABLE IF NOT EXISTS public.reseller_price_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
    plan VARCHAR(32) NOT NULL CHECK (plan IN ('MONTHLY', 'QUARTERLY', 'ANNUAL')),
    neko_cost NUMERIC(10,2) NOT NULL,
    resale_price NUMERIC(10,2) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_reseller_plan UNIQUE (reseller_id, plan),
    CONSTRAINT chk_min_resale_price CHECK (resale_price >= neko_cost),
    CONSTRAINT chk_neko_cost_official CHECK (
        (plan = 'MONTHLY' AND neko_cost = 39.00) OR
        (plan = 'QUARTERLY' AND neko_cost = 69.00) OR
        (plan = 'ANNUAL' AND neko_cost = 197.00)
    )
);

-- 3. TABELA PUBLIC.RESELLER_SALES
CREATE TABLE IF NOT EXISTS public.reseller_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE RESTRICT,
    license_id UUID DEFAULT NULL REFERENCES public.licenses(id) ON DELETE SET NULL,
    plan VARCHAR(32) NOT NULL CHECK (plan IN ('MONTHLY', 'QUARTERLY', 'ANNUAL')),
    neko_cost_snapshot NUMERIC(10,2) NOT NULL,
    resale_price_snapshot NUMERIC(10,2) NOT NULL,
    profit_snapshot NUMERIC(10,2) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'awaiting_customer', 'license_delivered', 'expired', 'cancelled')),
    mp_payment_id VARCHAR(128) UNIQUE DEFAULT NULL,
    mp_external_reference VARCHAR(128) UNIQUE NOT NULL,
    pix_qr_code TEXT DEFAULT NULL,
    pix_qr_code_base64 TEXT DEFAULT NULL,
    customer_name VARCHAR(128) DEFAULT NULL,
    customer_email VARCHAR(255) DEFAULT NULL,
    customer_whatsapp VARCHAR(32) DEFAULT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. ALTERAÇÃO NA TABELA PUBLIC.LICENSES (1 COLUNA APENAS)
ALTER TABLE public.licenses
    ADD COLUMN IF NOT EXISTS reseller_id UUID DEFAULT NULL REFERENCES public.resellers(id) ON DELETE SET NULL;

-- 5. ÍNDICES DE PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_resellers_user_id ON public.resellers(user_id);
CREATE INDEX IF NOT EXISTS idx_reseller_price_settings_reseller_id ON public.reseller_price_settings(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_reseller_id ON public.reseller_sales(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_license_id ON public.reseller_sales(license_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_mp_external_ref ON public.reseller_sales(mp_external_reference);
CREATE INDEX IF NOT EXISTS idx_reseller_sales_mp_payment_id ON public.reseller_sales(mp_payment_id);
CREATE INDEX IF NOT EXISTS idx_licenses_reseller_id ON public.licenses(reseller_id);

-- 6. TRIGGERS DE PROTEÇÃO DE CAMPOS PRIVILEGIADOS
CREATE OR REPLACE FUNCTION public.fn_protect_reseller_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF (auth.role() = 'authenticated') THEN
        IF (NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.status != OLD.status) THEN
            RAISE EXCEPTION 'Operação não autorizada: revendedores não podem alterar id, user_id ou status.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_reseller_profile ON public.resellers;
CREATE TRIGGER trg_protect_reseller_profile
    BEFORE UPDATE ON public.resellers
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_protect_reseller_profile();

CREATE OR REPLACE FUNCTION public.fn_protect_reseller_price_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF (auth.role() = 'authenticated') THEN
        IF (NEW.reseller_id != OLD.reseller_id OR NEW.neko_cost != OLD.neko_cost OR NEW.plan != OLD.plan) THEN
            RAISE EXCEPTION 'Operação não autorizada: apenas o preço de revenda (resale_price) pode ser alterado.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_reseller_price_settings ON public.reseller_price_settings;
CREATE TRIGGER trg_protect_reseller_price_settings
    BEFORE UPDATE ON public.reseller_price_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_protect_reseller_price_settings();

-- 7. HABILITAR RLS NAS TABELAS
ALTER TABLE public.resellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_price_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_sales ENABLE ROW LEVEL SECURITY;

-- POLICIES SERVICE_ROLE (SUPABASE SERVICE ROLE HAS FULL ACCESS)
DROP POLICY IF EXISTS p_service_role_resellers ON public.resellers;
CREATE POLICY p_service_role_resellers ON public.resellers FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_service_role_reseller_price_settings ON public.reseller_price_settings;
CREATE POLICY p_service_role_reseller_price_settings ON public.reseller_price_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_service_role_reseller_sales ON public.reseller_sales;
CREATE POLICY p_service_role_reseller_sales ON public.reseller_sales FOR ALL TO service_role USING (true) WITH CHECK (true);

-- POLICIES RESENDEDOR (AUTHENTICATED USERS)
DROP POLICY IF EXISTS p_reseller_select_self ON public.resellers;
CREATE POLICY p_reseller_select_self ON public.resellers
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS p_reseller_update_self ON public.resellers;
CREATE POLICY p_reseller_update_self ON public.resellers
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS p_reseller_price_settings_select ON public.reseller_price_settings;
CREATE POLICY p_reseller_price_settings_select ON public.reseller_price_settings
    FOR SELECT TO authenticated
    USING (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS p_reseller_price_settings_insert ON public.reseller_price_settings;
CREATE POLICY p_reseller_price_settings_insert ON public.reseller_price_settings
    FOR INSERT TO authenticated
    WITH CHECK (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS p_reseller_price_settings_update ON public.reseller_price_settings;
CREATE POLICY p_reseller_price_settings_update ON public.reseller_price_settings
    FOR UPDATE TO authenticated
    USING (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()))
    WITH CHECK (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

-- RESELLER SALES: SOMENTE LEITURA PARA REVENDEDOR (Mutações proibidas via cliente)
DROP POLICY IF EXISTS p_reseller_sales_select ON public.reseller_sales;
CREATE POLICY p_reseller_sales_select ON public.reseller_sales
    FOR SELECT TO authenticated
    USING (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

-- LICENSES: SOMENTE LEITURA PARA REVENDEDOR
DROP POLICY IF EXISTS p_reseller_licenses_select ON public.licenses;
CREATE POLICY p_reseller_licenses_select ON public.licenses
    FOR SELECT TO authenticated
    USING (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

-- 8. RPC ATÔMICA HARDENED: fn_issue_reseller_test_license
CREATE OR REPLACE FUNCTION public.fn_issue_reseller_test_license(
    p_reseller_id UUID,
    p_customer_name VARCHAR DEFAULT NULL,
    p_customer_email VARCHAR DEFAULT NULL,
    p_customer_whatsapp VARCHAR DEFAULT NULL,
    p_key_hash VARCHAR DEFAULT NULL,
    p_key_mask VARCHAR DEFAULT NULL,
    p_encrypted_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_calling_user_id UUID;
    v_actual_reseller_id UUID;
    v_reseller RECORD;
    v_tests_today INT;
    v_today_start TIMESTAMPTZ;
    v_expires_at TIMESTAMPTZ;
    v_new_license RECORD;
    v_default_entitlements TEXT[] := ARRAY['agent_execution', 'preview_server', 'file_manipulation', 'cloud_supabase', 'cloud_github', 'cloud_vercel'];
BEGIN
    v_calling_user_id := auth.uid();

    -- Validação de Autorização: Se chamado por usuário autenticado, garante que o p_reseller_id bate com o user_id logado
    IF (auth.role() = 'authenticated') THEN
        SELECT id INTO v_actual_reseller_id
        FROM public.resellers
        WHERE user_id = v_calling_user_id;

        IF v_actual_reseller_id IS NULL OR v_actual_reseller_id != p_reseller_id THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error_code', 'UNAUTHORIZED_RESELLER',
                'message', 'Operação não autorizada: revendedor só pode emitir testes para si próprio.'
            );
        END IF;
    END IF;

    -- Trava transacional exclusiva na linha do revendedor
    SELECT * INTO v_reseller
    FROM public.resellers
    WHERE id = p_reseller_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'RESELLER_NOT_FOUND', 'message', 'Revendedor não encontrado.');
    END IF;

    IF v_reseller.status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'RESELLER_INACTIVE', 'message', 'Conta de revendedor inativa ou suspensa.');
    END IF;

    -- Início do dia em UTC-3 (America/Sao_Paulo)
    v_today_start := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';

    -- Contagem atômica de testes de hoje
    SELECT COUNT(*) INTO v_tests_today
    FROM public.licenses
    WHERE reseller_id = p_reseller_id
      AND license_type = 'TEST'
      AND created_at >= v_today_start;

    IF v_tests_today >= 10 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error_code', 'TEST_QUOTA_EXCEEDED',
            'message', 'Quota diária de 10 licenças de teste atingida. Tente novamente amanhã.'
        );
    END IF;

    -- Expiração em 6 horas
    v_expires_at := now() + interval '6 hours';

    -- Insere licença TEST
    INSERT INTO public.licenses (
        user_id,
        reseller_id,
        key_hash,
        key_mask,
        plan,
        license_type,
        status,
        max_devices,
        customer_name,
        customer_email,
        customer_whatsapp,
        encrypted_key,
        expires_at,
        entitlements
    ) VALUES (
        NULL,
        p_reseller_id,
        p_key_hash,
        p_key_mask,
        'MONTHLY',
        'TEST',
        'active',
        1,
        NULLIF(trim(p_customer_name), ''),
        NULLIF(trim(p_customer_email), ''),
        NULLIF(trim(p_customer_whatsapp), ''),
        p_encrypted_key,
        v_expires_at,
        v_default_entitlements
    ) RETURNING * INTO v_new_license;

    -- Registra evento de auditoria
    INSERT INTO public.license_events (
        license_id,
        device_id,
        event_type,
        metadata
    ) VALUES (
        v_new_license.id,
        '00000000000000000000000000000000',
        'activate',
        jsonb_build_object(
            'source', 'reseller_test_flow',
            'reseller_id', p_reseller_id,
            'plan', 'MONTHLY',
            'license_type', 'TEST',
            'duration', '6h',
            'key_mask', p_key_mask,
            'customer_name', v_new_license.customer_name,
            'customer_email', v_new_license.customer_email
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'license_id', v_new_license.id,
        'key_mask', v_new_license.key_mask,
        'expires_at', v_new_license.expires_at,
        'tests_used_today', v_tests_today + 1
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_issue_reseller_test_license(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_issue_reseller_test_license(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT) TO service_role, authenticated;
