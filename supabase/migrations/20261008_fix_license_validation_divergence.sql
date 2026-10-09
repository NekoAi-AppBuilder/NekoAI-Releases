-- ============================================================================
-- NEKOAI LICENSE SYSTEM - MIGRATION v1.4.1 (INCREMENTAL & IDEMPOTENTE)
-- FIX: RESOLUÇÃO DETERMINÍSTICA E VÍNCULO ESTRITO DE IDENTIDADE DE LICENÇAS
-- Project: NekoAI Licences (igadprvhgmfnyvyqavhy - sa-east-1)
-- Environment: PROD (READY TO APPLY)
-- ============================================================================

-- 1. ÍNDICES DE PERFORMANCE PARA RESOLUÇÃO DETERMINÍSTICA DE LICENÇAS
CREATE INDEX IF NOT EXISTS idx_license_activations_device_lookup 
    ON public.license_activations(device_id, last_validated_at DESC);

CREATE INDEX IF NOT EXISTS idx_licenses_status_expiration 
    ON public.licenses(status, expires_at DESC);

-- ============================================================================
-- 2. RPC: VALIDAÇÃO COM IDENTIDADE ESTRITA (4 PARÂMETROS)
-- ============================================================================
-- Quando p_license_id é fornecido, valida EXCLUSIVAMENTE a licença solicitada e o
-- vínculo autorizado do dispositivo. Não faz troca silenciosa para outra licença.
-- Quando p_license_id é NULL, executa fluxo determinístico de descoberta com
-- prioridade estrita para licenças ativas e não expiradas.
CREATE OR REPLACE FUNCTION public.fn_validate_license_device(
    p_device_id VARCHAR,
    p_license_id UUID,
    p_ip INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_license RECORD;
    v_activation RECORD;
    v_active_valid_count INT;
BEGIN
    -- 1. Validação de formato de máquina
    IF p_device_id IS NULL OR p_device_id !~ '^[0-9a-fA-F]{32}$' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_DEVICE_FORMAT', 'message', 'Identificador de máquina inválido.');
    END IF;

    -- 2. Resolução da licença
    IF p_license_id IS NOT NULL THEN
        -- CAMINHO DE IDENTIDADE ESPECÍFICA:
        -- O cliente forneceu um license_id específico do grant verificado.
        -- Regra Obrigatória: Valida ESPECIFICAMENTE esta licença e seu vínculo autorizado.
        -- Jamais troca silenciosamente para outra licença encontrada na máquina.

        -- A. Busca a licença informada
        SELECT * INTO v_license
        FROM public.licenses
        WHERE id = p_license_id;

        IF NOT FOUND THEN
            INSERT INTO public.license_events (device_id, event_type, ip_address, user_agent, metadata)
            VALUES (p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'license_not_found', 'requested_license_id', p_license_id));

            RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'message', 'Licença não encontrada no servidor.');
        END IF;

        -- B. Valida o vínculo de autorização deste dispositivo para esta licença
        SELECT * INTO v_activation
        FROM public.license_activations
        WHERE license_id = p_license_id AND device_id = p_device_id;

        IF NOT FOUND THEN
            INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
            VALUES (p_license_id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'device_not_authorized_for_license'));

            RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'message', 'Dispositivo não autorizado para esta licença.');
        END IF;

    ELSE
        -- CAMINHO DE DESCOBERTA DETERMINÍSTICA E SEGURA:
        -- Nenhum license_id informado (ex: boot inicial sem grant local).
        -- 1. Verifica quantas licenças ativas e não expiradas estão autorizadas para este dispositivo.
        SELECT COUNT(*)
        INTO v_active_valid_count
        FROM public.license_activations la
        JOIN public.licenses l ON l.id = la.license_id
        WHERE la.device_id = p_device_id
          AND l.status = 'active'
          AND l.expires_at > now();

        IF v_active_valid_count = 0 THEN
            -- Nenhuma licença ativa e válida encontrada para este dispositivo.
            -- Não seleciona registros expirados/revogados para impor EXPIRED indevido em boot limpo.
            INSERT INTO public.license_events (device_id, event_type, ip_address, user_agent, metadata)
            VALUES (p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'no_active_license_found_for_device'));

            RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'message', 'Nenhuma licença ativa encontrada para este dispositivo.');
        ELSIF v_active_valid_count > 1 THEN
            -- Múltiplas licenças ativas vinculadas ao mesmo dispositivo:
            -- Ambiguidade comercial! Não há associação inequívoca sem o grant ou chave.
            -- Rejeita de forma controlada para orientar a ativação manual com a chave correta.
            INSERT INTO public.license_events (device_id, event_type, ip_address, user_agent, metadata)
            VALUES (p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'multiple_active_licenses_ambiguous', 'count', v_active_valid_count));

            RETURN jsonb_build_object('ok', false, 'error_code', 'AMBIGUOUS_LICENSE', 'message', 'Múltiplas licenças ativas vinculadas a este computador. Por favor, ative com sua chave de licença.');
        ELSE
            -- Exatamente UMA associação válida: associação inequívoca e segura confirmada.
            SELECT l.*, la.id AS activation_id
            INTO v_license
            FROM public.license_activations la
            JOIN public.licenses l ON l.id = la.license_id
            WHERE la.device_id = p_device_id
              AND l.status = 'active'
              AND l.expires_at > now()
            LIMIT 1;

            SELECT * INTO v_activation
            FROM public.license_activations
            WHERE id = v_license.activation_id;
        END IF;
    END IF;

    -- 3. Validação do Status Comercial no Banco de Dados (Fonte da Verdade)
    IF v_license.status = 'revoked' THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'license_revoked'));

        RETURN jsonb_build_object('ok', false, 'error_code', 'REVOKED', 'message', 'Esta licença foi revogada administrativamente.');
    END IF;

    IF v_license.status = 'expired' OR v_license.expires_at <= now() THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'license_expired', 'expires_at', v_license.expires_at));

        RETURN jsonb_build_object('ok', false, 'error_code', 'EXPIRED', 'message', 'Esta licença expirou.');
    END IF;

    IF v_license.status NOT IN ('active', 'past_due', 'cancelled') THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'unsupported_status', 'status', v_license.status));

        RETURN jsonb_build_object('ok', false, 'error_code', 'INACTIVE', 'message', 'Licença inativa ou em estado não autorizável.');
    END IF;

    -- 4. Atualiza timestamp da última validação na ativação autorizada
    UPDATE public.license_activations
    SET last_validated_at = now()
    WHERE id = v_activation.id;

    -- 5. Registro de auditoria do evento de validação bem-sucedida
    INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
    VALUES (
        v_license.id,
        p_device_id,
        'validate',
        p_ip,
        p_user_agent,
        jsonb_build_object('plan', v_license.plan, 'validated_at', now(), 'specific_license_requested', (p_license_id IS NOT NULL))
    );

    -- 6. Retorno autorizado para emissão do Grant
    RETURN jsonb_build_object(
        'ok', true,
        'license_id', v_license.id,
        'user_id', COALESCE(v_license.user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        'plan', CASE 
            WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
              OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
              OR (
                  v_license.expires_at IS NOT NULL 
                  AND v_license.created_at IS NOT NULL 
                  AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                  AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
              )
              OR v_license.key_mask ILIKE 'NEKO-TEST-%'
            THEN 'TEST' 
            ELSE v_license.plan 
        END,
        'license_type', CASE 
            WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
              OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
              OR (
                  v_license.expires_at IS NOT NULL 
                  AND v_license.created_at IS NOT NULL 
                  AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                  AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
              )
              OR v_license.key_mask ILIKE 'NEKO-TEST-%'
            THEN 'TEST' 
            ELSE COALESCE(v_license.license_type, 'NORMAL') 
        END,
        'status', v_license.status,
        'expires_at', v_license.expires_at,
        'entitlements', v_license.entitlements,
        'key_mask', v_license.key_mask,
        'max_devices', COALESCE(v_license.max_devices, 1),
        'active_devices', GREATEST(1, COALESCE((SELECT COUNT(*)::int FROM public.license_activations WHERE license_id = v_license.id), 1))
    );
END;
$$;

-- Permissões estritas da RPC de 4 parâmetros
REVOKE ALL ON FUNCTION public.fn_validate_license_device(VARCHAR, UUID, INET, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_validate_license_device(VARCHAR, UUID, INET, TEXT) TO service_role;

-- ============================================================================
-- 3. RPC LEGADA / DISCOVERY WRAPPER (3 PARÂMETROS)
-- ============================================================================
-- Preserva compatibilidade integral com quaisquer chamadores existentes da
-- assinatura antiga de 3 parâmetros, sem ambiguidade de resolução no PostgreSQL.
CREATE OR REPLACE FUNCTION public.fn_validate_license_device(
    p_device_id VARCHAR,
    p_ip INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN public.fn_validate_license_device(p_device_id, NULL::uuid, p_ip, p_user_agent);
END;
$$;

-- Permissões estritas da RPC legada
REVOKE ALL ON FUNCTION public.fn_validate_license_device(VARCHAR, INET, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_validate_license_device(VARCHAR, INET, TEXT) TO service_role;

-- ============================================================================
-- 4. RPC: ATIVAÇÃO DE DISPOSITIVO COM RETORNO DE CONEXÕES (max_devices / active_devices)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_activate_license_device(
    p_license_key_hash VARCHAR,
    p_device_id VARCHAR,
    p_device_name VARCHAR DEFAULT 'NekoAI Station',
    p_ip INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_license RECORD;
    v_existing_activation RECORD;
    v_active_count INT;
    v_is_reactivation BOOLEAN := false;
BEGIN
    -- 1. Validação de formato de entrada
    IF p_license_key_hash IS NULL OR p_license_key_hash !~ '^[0-9a-fA-F]{64}$' THEN
        INSERT INTO public.license_events (device_id, event_type, ip_address, user_agent, metadata)
        VALUES (COALESCE(p_device_id, '00000000000000000000000000000000'), 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'invalid_key_hash_format'));
        RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_KEY_FORMAT', 'message', 'Formato de chave inválido.');
    END IF;

    IF p_device_id IS NULL OR p_device_id !~ '^[0-9a-fA-F]{32}$' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_DEVICE_FORMAT', 'message', 'Identificador de máquina inválido.');
    END IF;

    -- 2. Bloqueio exclusivo transacional (FOR UPDATE) na linha da licença para serializar ativações concorrentes
    SELECT * INTO v_license
    FROM public.licenses
    WHERE key_hash = p_license_key_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.license_events (device_id, event_type, ip_address, user_agent, metadata)
        VALUES (p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'key_not_found'));
        RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'message', 'Chave de licença não encontrada.');
    END IF;

    -- 3. Validação de Status Comercial
    IF v_license.status = 'revoked' THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'license_revoked'));
        RETURN jsonb_build_object('ok', false, 'error_code', 'REVOKED', 'message', 'Esta licença foi revogada administrativamente.');
    END IF;

    IF v_license.status = 'expired' OR v_license.expires_at <= now() THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'license_expired', 'status', v_license.status));
        RETURN jsonb_build_object('ok', false, 'error_code', 'EXPIRED', 'message', 'Esta licença expirou.');
    END IF;

    IF v_license.status NOT IN ('active', 'past_due', 'cancelled') THEN
        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object('reason', 'unsupported_status', 'status', v_license.status));
        RETURN jsonb_build_object('ok', false, 'error_code', 'INACTIVE', 'message', 'Licença inativa ou em estado não autorizável.');
    END IF;

    -- 4. Verifica se este dispositivo específico já está ativo nesta licença
    SELECT * INTO v_existing_activation
    FROM public.license_activations
    WHERE license_id = v_license.id AND device_id = p_device_id;

    IF FOUND THEN
        -- Idempotência: mesmo dispositivo renova/revalida
        v_is_reactivation := true;
        UPDATE public.license_activations
        SET last_validated_at = now(), device_name = p_device_name
        WHERE id = v_existing_activation.id;
    ELSE
        -- Novo dispositivo: conta quantas ativações já existem
        SELECT COUNT(*) INTO v_active_count
        FROM public.license_activations
        WHERE license_id = v_license.id;

        IF v_active_count >= v_license.max_devices THEN
            INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
            VALUES (v_license.id, p_device_id, 'failed_attempt', p_ip, p_user_agent, jsonb_build_object(
                'reason', 'device_limit_exceeded',
                'active_count', v_active_count,
                'max_devices', v_license.max_devices
            ));

            -- Para max_devices = 1, mantém DEVICE_ALREADY_ACTIVE para fluxo do Desktop
            IF v_license.max_devices = 1 THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error_code', 'DEVICE_ALREADY_ACTIVE',
                    'message', 'Esta licença já está ativada em outro dispositivo.'
                );
            ELSE
                RETURN jsonb_build_object(
                    'ok', false,
                    'error_code', 'DEVICE_LIMIT_EXCEEDED',
                    'message', 'Limite de dispositivos atingido (' || v_active_count || '/' || v_license.max_devices || '). Desative um dispositivo antes de conectar um novo.'
                );
            END IF;
        END IF;

        -- Insere nova ativação
        INSERT INTO public.license_activations (license_id, device_id, device_name, last_validated_at)
        VALUES (v_license.id, p_device_id, p_device_name, now());
    END IF;

    -- 5. Auditoria
    INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
    VALUES (
        v_license.id, 
        p_device_id, 
        CASE WHEN v_is_reactivation THEN 'validate' ELSE 'activate' END, 
        p_ip, 
        p_user_agent, 
        jsonb_build_object('plan', v_license.plan, 'is_reactivation', v_is_reactivation, 'max_devices', v_license.max_devices)
    );

    -- 6. Retorno para emissão do Grant com sincronismo de conexões
    RETURN jsonb_build_object(
        'ok', true,
        'license_id', v_license.id,
        'user_id', COALESCE(v_license.user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        'plan', CASE 
            WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
              OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
              OR (
                  v_license.expires_at IS NOT NULL 
                  AND v_license.created_at IS NOT NULL 
                  AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                  AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
              )
              OR v_license.key_mask ILIKE 'NEKO-TEST-%'
            THEN 'TEST' 
            ELSE v_license.plan 
        END,
        'license_type', CASE 
            WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
              OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
              OR (
                  v_license.expires_at IS NOT NULL 
                  AND v_license.created_at IS NOT NULL 
                  AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                  AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
              )
              OR v_license.key_mask ILIKE 'NEKO-TEST-%'
            THEN 'TEST' 
            ELSE COALESCE(v_license.license_type, 'NORMAL') 
        END,
        'status', v_license.status,
        'expires_at', v_license.expires_at,
        'entitlements', v_license.entitlements,
        'key_mask', v_license.key_mask,
        'max_devices', COALESCE(v_license.max_devices, 1),
        'active_devices', GREATEST(1, COALESCE((SELECT COUNT(*)::int FROM public.license_activations WHERE license_id = v_license.id), 1))
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_activate_license_device(VARCHAR, VARCHAR, VARCHAR, INET, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_activate_license_device(VARCHAR, VARCHAR, VARCHAR, INET, TEXT) TO service_role;

-- ============================================================================
-- 5. RPC: RESET DE DISPOSITIVO COM RETORNO DE CONEXÕES (max_devices / active_devices)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_reset_license_device(
    p_license_key_hash VARCHAR,
    p_device_id VARCHAR,
    p_device_name VARCHAR DEFAULT 'NekoAI Station',
    p_ip INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_license RECORD;
    v_old_device_id VARCHAR := NULL;
    v_old_activation RECORD;
    v_active_count INT;
BEGIN
    IF p_license_key_hash IS NULL OR p_license_key_hash !~ '^[0-9a-fA-F]{64}$' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_KEY_FORMAT', 'message', 'Formato de chave inválido.');
    END IF;

    IF p_device_id IS NULL OR p_device_id !~ '^[0-9a-fA-F]{32}$' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_DEVICE_FORMAT', 'message', 'Identificador de máquina inválido.');
    END IF;

    -- Bloqueio exclusivo transacional
    SELECT * INTO v_license
    FROM public.licenses
    WHERE key_hash = p_license_key_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'message', 'Chave de licença não encontrada.');
    END IF;

    IF v_license.status = 'revoked' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'REVOKED', 'message', 'Esta licença foi revogada administrativamente.');
    END IF;

    IF v_license.status = 'expired' OR v_license.expires_at <= now() THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'EXPIRED', 'message', 'Esta licença expirou.');
    END IF;

    -- Se a licença é de 1 dispositivo: comportamento de substituição instantânea preservado
    IF v_license.max_devices = 1 THEN
        SELECT * INTO v_old_activation
        FROM public.license_activations
        WHERE license_id = v_license.id;

        IF FOUND THEN
            v_old_device_id := v_old_activation.device_id;
        END IF;

        DELETE FROM public.license_activations WHERE license_id = v_license.id;
        
        INSERT INTO public.license_activations (license_id, device_id, device_name, last_validated_at)
        VALUES (v_license.id, p_device_id, p_device_name, now());

        UPDATE public.licenses SET updated_at = now() WHERE id = v_license.id;

        INSERT INTO public.license_events (license_id, device_id, event_type, ip_address, user_agent, metadata)
        VALUES (
            v_license.id, 
            p_device_id, 
            'device_reset', 
            p_ip, 
            p_user_agent, 
            jsonb_build_object('previous_device_id', v_old_device_id, 'plan', v_license.plan, 'instant_transfer', true)
        );

        RETURN jsonb_build_object(
            'ok', true,
            'license_id', v_license.id,
            'user_id', COALESCE(v_license.user_id, '00000000-0000-0000-0000-000000000000'::uuid),
            'plan', CASE 
                WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
                  OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
                  OR (
                      v_license.expires_at IS NOT NULL 
                      AND v_license.created_at IS NOT NULL 
                      AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                      AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
                  )
                  OR v_license.key_mask ILIKE 'NEKO-TEST-%'
                THEN 'TEST' 
                ELSE v_license.plan 
            END,
            'license_type', CASE 
                WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
                  OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
                  OR (
                      v_license.expires_at IS NOT NULL 
                      AND v_license.created_at IS NOT NULL 
                      AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                      AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
                  )
                  OR v_license.key_mask ILIKE 'NEKO-TEST-%'
                THEN 'TEST' 
                ELSE COALESCE(v_license.license_type, 'NORMAL') 
            END,
            'status', v_license.status,
            'expires_at', v_license.expires_at,
            'entitlements', v_license.entitlements,
            'key_mask', v_license.key_mask,
            'max_devices', COALESCE(v_license.max_devices, 1),
            'active_devices', GREATEST(1, COALESCE((SELECT COUNT(*)::int FROM public.license_activations WHERE license_id = v_license.id), 1))
        );
    ELSE
        -- Para licenças com max_devices > 1:
        -- Verifica se ainda há vagas
        SELECT COUNT(*) INTO v_active_count
        FROM public.license_activations
        WHERE license_id = v_license.id;

        IF v_active_count < v_license.max_devices THEN
            -- Há vagas: ativa normalmente sem apagar ninguém
            INSERT INTO public.license_activations (license_id, device_id, device_name, last_validated_at)
            VALUES (v_license.id, p_device_id, p_device_name, now());

            RETURN jsonb_build_object(
                'ok', true,
                'license_id', v_license.id,
                'user_id', COALESCE(v_license.user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                'plan', CASE 
                    WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
                      OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
                      OR (
                          v_license.expires_at IS NOT NULL 
                          AND v_license.created_at IS NOT NULL 
                          AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                          AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
                      )
                      OR v_license.key_mask ILIKE 'NEKO-TEST-%'
                    THEN 'TEST' 
                    ELSE v_license.plan 
                END,
                'license_type', CASE 
                    WHEN UPPER(COALESCE(v_license.license_type, '')) = 'TEST' 
                      OR UPPER(COALESCE(v_license.plan, '')) IN ('TEST', 'TESTE')
                      OR (
                          v_license.expires_at IS NOT NULL 
                          AND v_license.created_at IS NOT NULL 
                          AND (v_license.expires_at - v_license.created_at) <= interval '7 days 1 hour'
                          AND UPPER(COALESCE(v_license.plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
                      )
                      OR v_license.key_mask ILIKE 'NEKO-TEST-%'
                    THEN 'TEST' 
                    ELSE COALESCE(v_license.license_type, 'NORMAL') 
                END,
                'status', v_license.status,
                'expires_at', v_license.expires_at,
                'entitlements', v_license.entitlements,
                'key_mask', v_license.key_mask,
                'max_devices', COALESCE(v_license.max_devices, 1),
                'active_devices', GREATEST(1, COALESCE((SELECT COUNT(*)::int FROM public.license_activations WHERE license_id = v_license.id), 1))
            );
        ELSE
            -- Limite atingido: NÃO apaga todos os dispositivos silenciosamente
            RETURN jsonb_build_object(
                'ok', false,
                'error_code', 'DEVICE_LIMIT_EXCEEDED',
                'message', 'Todos os ' || v_license.max_devices || ' dispositivos permitidos já estão em uso. Desative um dos computadores cadastrados para liberar uma vaga.'
            );
        END IF;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reset_license_device(VARCHAR, VARCHAR, VARCHAR, INET, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reset_license_device(VARCHAR, VARCHAR, VARCHAR, INET, TEXT) TO service_role;

-- ============================================================================
-- 6. NORMALIZAÇÃO DETERMINÍSTICA DE LICENÇAS DE TESTE NO BANCO DE DADOS
-- ============================================================================
-- 6.1 Atualiza a constraint chk_licenses_plan_enum (se existir) para permitir TEST/TESTE
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'chk_licenses_plan_enum'
    ) THEN
        ALTER TABLE public.licenses DROP CONSTRAINT chk_licenses_plan_enum;
        ALTER TABLE public.licenses ADD CONSTRAINT chk_licenses_plan_enum CHECK (plan IN ('MONTHLY', 'QUARTERLY', 'ANNUAL', 'TEST', 'TESTE'));
    END IF;
END $$;

-- 6.2 Atualiza idempotentemente qualquer licença existente no banco de dados que
-- seja de teste (por chave NEKO-TEST- ou duração de teste <= 7 dias)
-- para que license_type seja rigorosamente 'TEST'. Não força alteração na coluna plan,
-- preservando compatibilidade com qualquer restrição legada.
UPDATE public.licenses
SET license_type = 'TEST'
WHERE (
    key_mask ILIKE 'NEKO-TEST-%'
    OR (
        expires_at IS NOT NULL 
        AND created_at IS NOT NULL 
        AND (expires_at - created_at) <= interval '7 days 1 hour'
        AND UPPER(COALESCE(plan, '')) NOT IN ('QUARTERLY', 'ANNUAL', 'TRIMESTRAL', 'ANUAL')
    )
  )
  AND (license_type IS NULL OR license_type != 'TEST');


