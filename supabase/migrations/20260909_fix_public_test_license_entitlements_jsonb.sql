-- ============================================================================
-- NEKOAI PUBLIC TEST GRANT — FIX: entitlements JSONB (migration corretiva)
-- A coluna public.licenses.entitlements é JSONB. A RPC anterior atribuía
-- p_entitlements (text[]) diretamente, causando:
--   column "entitlements" is of type jsonb but expression is of type text[]
-- Esta migration reescreve SOMENTE essa atribuição, convertendo text[] -> jsonb.
-- Mantém a mesma assinatura, SECURITY DEFINER, search_path, atomicidade,
-- UNIQUE(ip), rollback e o retorno IP_ALREADY_GRANTED.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_create_public_test_license(
    p_ip text,
    p_key_hash text,
    p_key_mask text,
    p_plan text,
    p_license_type text,
    p_status text,
    p_max_devices integer,
    p_expires_at timestamptz,
    p_entitlements text[],
    p_customer_name text,
    p_customer_email text,
    p_customer_whatsapp text,
    p_encrypted_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_grant_id uuid;
    v_license_id uuid;
BEGIN
    -- Concede o IP (a UNIQUE(ip) bloqueia a 2ª requisição simultânea do mesmo IP).
    BEGIN
        INSERT INTO public.public_test_grants (ip)
        VALUES (p_ip)
        RETURNING id INTO v_grant_id;
    EXCEPTION
        WHEN unique_violation THEN
            RETURN jsonb_build_object('ok', false, 'error_code', 'IP_ALREADY_GRANTED');
    END;

    -- Cria a licença TEST na MESMA transação, convertendo entitlements p/ jsonb.
    INSERT INTO public.licenses (
        user_id, key_hash, key_mask, plan, license_type, status,
        max_devices, customer_name, customer_email, customer_whatsapp,
        expires_at, entitlements, encrypted_key
    )
    VALUES (
        NULL, p_key_hash, p_key_mask, p_plan, p_license_type, p_status,
        p_max_devices, p_customer_name, p_customer_email, p_customer_whatsapp,
        p_expires_at, to_jsonb(p_entitlements), p_encrypted_key
    )
    RETURNING id INTO v_license_id;

    -- Associa a licença à concessão do IP.
    UPDATE public.public_test_grants
    SET license_id = v_license_id
    WHERE id = v_grant_id;

    RETURN jsonb_build_object('ok', true, 'license_id', v_license_id);
END;
$$;

-- Reafirma a restrição de execução: somente service_role.
REVOKE ALL ON FUNCTION public.fn_create_public_test_license(text, text, text, text, text, text, integer, timestamptz, text[], text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_public_test_license(text, text, text, text, text, text, integer, timestamptz, text[], text, text, text, text) TO service_role;