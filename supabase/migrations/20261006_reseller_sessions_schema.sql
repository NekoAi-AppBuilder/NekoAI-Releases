-- ============================================================================
-- NEKOAI RESELLER MODULE - RESELLER SESSIONS & DEVICE MANAGEMENT SCHEMA
-- Migration: 20261006_reseller_sessions_schema.sql
-- Status: LOCAL ONLY — NÃO EXECUTADA NO SUPABASE REMOTO (CONFORME REGRAS ABSOLUTAS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reseller_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    device_name VARCHAR(128) NOT NULL,
    browser VARCHAR(64) NOT NULL,
    operating_system VARCHAR(64) NOT NULL,
    user_agent TEXT DEFAULT NULL,
    ip_address VARCHAR(64) DEFAULT NULL,
    approximate_location VARCHAR(128) DEFAULT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ DEFAULT NULL,
    CONSTRAINT uq_reseller_session_id UNIQUE (session_id)
);

-- Índices de performance e consulta rápida
CREATE INDEX IF NOT EXISTS idx_reseller_sessions_reseller_id ON public.reseller_sessions(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sessions_session_id ON public.reseller_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_reseller_sessions_active ON public.reseller_sessions(reseller_id, is_revoked, last_active_at DESC);

-- Habilitar RLS
ALTER TABLE public.reseller_sessions ENABLE ROW LEVEL SECURITY;

-- Políticas de RLS
-- 1. Service Role tem acesso irrestrito
DROP POLICY IF EXISTS p_service_role_reseller_sessions ON public.reseller_sessions;
CREATE POLICY p_service_role_reseller_sessions ON public.reseller_sessions
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- 2. Revendedor autenticado só pode consultar suas próprias sessões
DROP POLICY IF EXISTS p_reseller_sessions_select ON public.reseller_sessions;
CREATE POLICY p_reseller_sessions_select ON public.reseller_sessions
    FOR SELECT TO authenticated
    USING (reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid()));

-- 3. Mutações diretas pelo cliente público são proibidas via RLS; gerenciadas exclusivamente via Edge Functions
REVOKE INSERT, UPDATE, DELETE ON public.reseller_sessions FROM anon, authenticated;
GRANT SELECT ON public.reseller_sessions TO authenticated;
GRANT ALL ON public.reseller_sessions TO service_role;
