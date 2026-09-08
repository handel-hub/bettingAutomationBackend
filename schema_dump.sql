--
-- PostgreSQL database dump
--

\restrict vdMhMF6stglJc6yts0ND1dXRdwxz0eofE4GZ6i9gTZEsmggH2tyk5HZJ6ThdHry

-- Dumped from database version 18.1
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: reject_generation_decrease(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_generation_decrease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.session_generation < OLD.session_generation
     OR NEW.authorization_revision < OLD.authorization_revision
     OR NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'generation counter decrease rejected';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: reject_license_revision_decrease(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_license_revision_decrease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.license_revision < OLD.license_revision THEN
    RAISE EXCEPTION 'license_revision decrease rejected';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: reject_machine_generation_decrease(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_machine_generation_decrease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'machine_generation decrease rejected';
  END IF;
  RETURN NEW;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_generation_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_generation_states (
    account_id uuid NOT NULL,
    license_revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    account_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    credentials_hash character varying(512) NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    lockout_count integer DEFAULT 0 NOT NULL,
    lockout_expires_at timestamp with time zone,
    last_event_hash character varying(64) DEFAULT encode(sha256('\x47454e45534953'::bytea), 'hex'::text) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounts_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'LOCKED'::character varying, 'SUSPENDED'::character varying, 'DELETED'::character varying])::text[])))
);


--
-- Name: admin_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    admin_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    credentials_hash character varying(512) NOT NULL,
    role character varying(20) NOT NULL,
    mfa_secret character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_users_role_check CHECK (((role)::text = ANY ((ARRAY['SUPER_ADMIN'::character varying, 'LICENSE_ADMIN'::character varying, 'SUPPORT'::character varying, 'AUDIT'::character varying])::text[])))
);


--
-- Name: authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authorizations (
    authorization_id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    license_id uuid,
    status character varying(20) DEFAULT 'VALID'::character varying NOT NULL,
    capability_set jsonb NOT NULL,
    policy_version integer DEFAULT 1 NOT NULL,
    authorization_revision bigint DEFAULT 1 NOT NULL,
    observed_license_revision bigint NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT authorizations_status_check CHECK (((status)::text = ANY ((ARRAY['VALID'::character varying, 'EXPIRED'::character varying, 'REVOKED'::character varying, 'SUPERSEDED'::character varying])::text[])))
);


--
-- Name: automation_account_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_account_configs (
    account_id uuid NOT NULL,
    bet_cycle_enabled boolean DEFAULT true NOT NULL,
    pricing_source character varying(20) DEFAULT 'GLOBAL'::character varying NOT NULL,
    risk_source character varying(20) DEFAULT 'GLOBAL'::character varying NOT NULL,
    rebet_source character varying(20) DEFAULT 'GLOBAL'::character varying NOT NULL,
    custom_pricing jsonb,
    custom_risk jsonb,
    custom_rebet jsonb,
    browser_status character varying(50) DEFAULT 'STOPPED'::character varying NOT NULL,
    account_status character varying(50) DEFAULT 'IDLE'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_account_configs_account_status_check CHECK (((account_status)::text = ANY ((ARRAY['IDLE'::character varying, 'IN_USE'::character varying, 'PROCESSING'::character varying, 'DEGRADED'::character varying])::text[]))),
    CONSTRAINT automation_account_configs_browser_status_check CHECK (((browser_status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'STOPPED'::character varying, 'LAUNCHING'::character varying, 'CRASHED'::character varying])::text[]))),
    CONSTRAINT automation_account_configs_pricing_source_check CHECK (((pricing_source)::text = ANY ((ARRAY['GLOBAL'::character varying, 'CUSTOM'::character varying])::text[]))),
    CONSTRAINT automation_account_configs_rebet_source_check CHECK (((rebet_source)::text = ANY ((ARRAY['GLOBAL'::character varying, 'CUSTOM'::character varying])::text[]))),
    CONSTRAINT automation_account_configs_risk_source_check CHECK (((risk_source)::text = ANY ((ARRAY['GLOBAL'::character varying, 'CUSTOM'::character varying])::text[])))
);


--
-- Name: backend_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backend_keys (
    key_id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_version integer NOT NULL,
    public_key_hex character varying(64) NOT NULL,
    status character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    destroyed_at timestamp with time zone,
    CONSTRAINT backend_keys_status_check CHECK (((status)::text = ANY ((ARRAY['GENERATED'::character varying, 'ACTIVE'::character varying, 'ROTATION_PENDING'::character varying, 'ROTATED'::character varying, 'RETIRED'::character varying, 'DESTROYED'::character varying, 'KEY_COMPROMISED'::character varying])::text[])))
);


--
-- Name: backend_trust_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backend_trust_state (
    singleton_guard boolean DEFAULT true NOT NULL,
    server_trust_version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backend_trust_state_singleton_guard_check CHECK (singleton_guard)
);


--
-- Name: betting_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.betting_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    platform_display_name character varying(100) NOT NULL,
    account_username character varying(255) NOT NULL,
    account_password_encrypted text NOT NULL,
    password_iv character varying(32) NOT NULL,
    password_tag character varying(32) NOT NULL,
    avatar_url text,
    backend_state character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    presentation_category character varying(50) DEFAULT 'Healthy'::character varying NOT NULL,
    status_description text DEFAULT 'Account registered and ready for activation'::text NOT NULL,
    warning_message text,
    is_selectable boolean DEFAULT true NOT NULL,
    available_actions jsonb DEFAULT '["ACTIVATE", "DELETE"]'::jsonb NOT NULL,
    pending_operation jsonb,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_synchronization timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT betting_accounts_backend_state_check CHECK (((backend_state)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SUSPENDED'::character varying, 'LOCKED'::character varying, 'ARCHIVED'::character varying])::text[]))),
    CONSTRAINT betting_accounts_platform_display_name_check CHECK (((platform_display_name)::text = ANY ((ARRAY['SportyBet'::character varying, 'Bet9ja'::character varying, 'BetKing'::character varying, '1xBet'::character varying, 'Betway'::character varying, 'Bet365'::character varying, 'Pinnacle'::character varying])::text[]))),
    CONSTRAINT betting_accounts_presentation_category_check CHECK (((presentation_category)::text = ANY ((ARRAY['Healthy'::character varying, 'Warning'::character varying, 'Critical'::character varying, 'Neutral'::character varying])::text[])))
);


--
-- Name: diagnostic_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostic_reports (
    report_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    machine_id uuid,
    telemetry jsonb DEFAULT '{}'::jsonb NOT NULL,
    recent_logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: file_transfer_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_transfer_chunks (
    transfer_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    chunk_offset bigint NOT NULL,
    chunk_size integer NOT NULL,
    chunk_hash character varying(128) NOT NULL,
    acked boolean DEFAULT false NOT NULL,
    acked_at timestamp with time zone
);


--
-- Name: file_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_transfers (
    transfer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    remote_session_id uuid NOT NULL,
    file_id character varying(255) NOT NULL,
    total_size bigint NOT NULL,
    total_chunks integer NOT NULL,
    chunk_size integer NOT NULL,
    content_hash character varying(128) NOT NULL,
    hash_algorithm character varying(20) DEFAULT 'sha256'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    acked_chunks jsonb DEFAULT '[]'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'INITIALIZING'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_transfers_status_check CHECK (((status)::text = ANY ((ARRAY['INITIALIZING'::character varying, 'UPLOADING'::character varying, 'COMPLETING'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: global_automation_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_automation_configs (
    id character varying(50) DEFAULT 'primary'::character varying NOT NULL,
    account_id uuid,
    pricing jsonb NOT NULL,
    risk jsonb NOT NULL,
    rebet jsonb NOT NULL,
    proxy jsonb NOT NULL,
    execution jsonb NOT NULL,
    browser_spawning jsonb NOT NULL,
    advanced_runtime jsonb NOT NULL,
    lifecycle character varying(50) DEFAULT 'STOPPED'::character varying NOT NULL,
    lifecycle_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT global_automation_configs_lifecycle_check CHECK (((lifecycle)::text = ANY ((ARRAY['STOPPED'::character varying, 'STARTING'::character varying, 'RUNNING'::character varying, 'STOPPING'::character varying, 'ERROR_DEGRADED'::character varying])::text[])))
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id character varying(100) NOT NULL,
    account_id uuid NOT NULL,
    reference character varying(255) NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character varying(10) DEFAULT 'NGN'::character varying NOT NULL,
    status character varying(50) NOT NULL,
    paid_at timestamp with time zone,
    receipt_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_status_check CHECK (((status)::text = ANY ((ARRAY['Paid'::character varying, 'Failed'::character varying, 'Pending'::character varying])::text[])))
);


--
-- Name: licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.licenses (
    license_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    machine_binding uuid,
    plan_id character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'UNKNOWN'::character varying NOT NULL,
    capabilities jsonb NOT NULL,
    limits jsonb NOT NULL,
    license_revision bigint DEFAULT 1 NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_verified_at timestamp with time zone,
    keygen_license_id character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT licenses_status_check CHECK (((status)::text = ANY ((ARRAY['UNKNOWN'::character varying, 'VALID'::character varying, 'EXPIRING'::character varying, 'EXPIRED'::character varying, 'REVOKED'::character varying, 'SUSPENDED'::character varying, 'INVALID'::character varying])::text[])))
);


--
-- Name: machine_session_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine_session_states (
    account_id uuid NOT NULL,
    machine_id uuid NOT NULL,
    session_generation bigint DEFAULT 1 NOT NULL,
    authorization_revision bigint DEFAULT 1 NOT NULL,
    machine_generation bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machines (
    machine_id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    public_key_hex character varying(64) NOT NULL,
    status character varying(30) DEFAULT 'REGISTERED'::character varying NOT NULL,
    machine_generation bigint DEFAULT 1 NOT NULL,
    descriptor jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT machines_status_check CHECK (((status)::text = ANY ((ARRAY['REGISTERED'::character varying, 'VERIFIED'::character varying, 'CORRUPTED'::character varying, 'REPLACEMENT_REQUIRED'::character varying, 'RE_VERIFICATION_REQUIRED'::character varying, 'REVOKED'::character varying])::text[])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id character varying(100) NOT NULL,
    account_id uuid NOT NULL,
    severity character varying(50) NOT NULL,
    category character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_category_check CHECK (((category)::text = ANY ((ARRAY['AUTOMATION'::character varying, 'ACCOUNT'::character varying, 'SYSTEM'::character varying, 'SECURITY'::character varying])::text[]))),
    CONSTRAINT notifications_severity_check CHECK (((severity)::text = ANY ((ARRAY['CRITICAL'::character varying, 'WARNING'::character varying, 'INFO'::character varying, 'SUCCESS'::character varying])::text[])))
);


--
-- Name: operator_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_settings (
    account_id uuid NOT NULL,
    name character varying(255) DEFAULT 'Operator'::character varying NOT NULL,
    avatar_url text,
    pending_email character varying(255),
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret character varying(255),
    automation_preferences jsonb DEFAULT '{"maxConcurrentRuns": 2, "defaultExecutionMode": "auto"}'::jsonb NOT NULL,
    notification_preferences jsonb DEFAULT '{"pushAlerts": true, "emailAlerts": true, "weeklyReport": false}'::jsonb NOT NULL,
    presentation_preferences jsonb DEFAULT '{"theme": "system", "density": "comfortable"}'::jsonb NOT NULL,
    account_status character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    deletion_scheduled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_settings_account_status_check CHECK (((account_status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'PENDING_DELETION'::character varying])::text[])))
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type character varying(50) NOT NULL,
    payload jsonb NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    claimed_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    worker_id character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_events_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'DELIVERED'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_event_id character varying(255) NOT NULL,
    provider character varying(50) NOT NULL,
    event_type character varying(50) NOT NULL,
    account_id uuid NOT NULL,
    subscription_id uuid,
    amount numeric(10,2),
    currency character varying(3),
    status character varying(20) DEFAULT 'RECEIVED'::character varying NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT payment_events_status_check CHECK (((status)::text = ANY ((ARRAY['RECEIVED'::character varying, 'PROCESSING'::character varying, 'PROCESSED'::character varying, 'FAILED'::character varying])::text[])))
);


--
-- Name: plan_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_entitlements (
    plan_id character varying(50) NOT NULL,
    capabilities jsonb NOT NULL,
    limits jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: revocation_circuit_breaker; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revocation_circuit_breaker (
    window_start timestamp with time zone NOT NULL,
    revocation_count integer DEFAULT 0 NOT NULL,
    tripped boolean DEFAULT false NOT NULL,
    overridden_by uuid,
    overridden_reason text
);


--
-- Name: scheduled_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_jobs (
    job_name character varying(100) NOT NULL,
    last_run_at timestamp with time zone,
    last_success_at timestamp with time zone,
    locked_until timestamp with time zone
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying(255) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    machine_id uuid,
    session_id uuid,
    event_type character varying(50) NOT NULL,
    severity character varying(20) NOT NULL,
    actor_type character varying(10) NOT NULL,
    actor_id character varying(255),
    session_generation bigint,
    machine_generation bigint,
    authorization_revision bigint,
    transaction_id uuid,
    old_state character varying(50),
    new_state character varying(50),
    result character varying(20) NOT NULL,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash character varying(64) NOT NULL,
    event_hash character varying(64) NOT NULL,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_events_actor_type_check CHECK (((actor_type)::text = ANY ((ARRAY['SYSTEM'::character varying, 'USER'::character varying, 'ADMIN'::character varying, 'PROVIDER'::character varying])::text[]))),
    CONSTRAINT security_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['LOGIN_SUCCESS'::character varying, 'LOGIN_FAILURE'::character varying, 'SESSION_RENEWED'::character varying, 'SESSION_EXPIRED'::character varying, 'SESSION_REVOKED'::character varying, 'LICENSE_CHANGED'::character varying, 'LICENSE_REVOKED'::character varying, 'LICENSE_CREATED'::character varying, 'LICENSE_SUSPENDED'::character varying, 'LICENSE_REACTIVATED'::character varying, 'MACHINE_IDENTITY_CHANGED'::character varying, 'MACHINE_REGISTERED'::character varying, 'MACHINE_REVOKED'::character varying, 'MACHINE_CLONE_DETECTED'::character varying, 'KEY_ROTATED'::character varying, 'SERVER_KEY_CHANGED'::character varying, 'INTEGRITY_FAILURE'::character varying, 'ROLLBACK_DETECTED'::character varying, 'CLOCK_ANOMALY'::character varying, 'STORAGE_CORRUPTION'::character varying, 'UNAUTHORIZED_IPC'::character varying, 'AUTHORIZATION_GRANTED'::character varying, 'AUTHORIZATION_REVOKED'::character varying, 'AUTHORIZATION_EXPIRED'::character varying, 'PAYMENT_RECEIVED'::character varying, 'PAYMENT_FAILED'::character varying, 'PAYMENT_REFUNDED'::character varying, 'ACCOUNT_LOCKED'::character varying, 'ACCOUNT_SUSPENDED'::character varying, 'ACCOUNT_REINSTATED'::character varying, 'ADMIN_ACTION'::character varying, 'CIRCUIT_BREAKER_TRIGGERED'::character varying, 'CIRCUIT_BREAKER_OVERRIDDEN'::character varying, 'RECONCILIATION_PERFORMED'::character varying, 'GENERATION_COUNTER_FORGERY'::character varying, 'REVOCATION_CASCADE'::character varying])::text[]))),
    CONSTRAINT security_events_result_check CHECK (((result)::text = ANY ((ARRAY['SUCCESS'::character varying, 'FAILURE'::character varying, 'DENIED'::character varying, 'ERROR'::character varying])::text[]))),
    CONSTRAINT security_events_severity_check CHECK (((severity)::text = ANY ((ARRAY['LOW'::character varying, 'MEDIUM'::character varying, 'HIGH'::character varying, 'CRITICAL'::character varying])::text[])))
);


--
-- Name: server_nonces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_nonces (
    nonce character varying(128) NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    epoch bigint NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    machine_id uuid NOT NULL,
    status character varying(20) DEFAULT 'AUTHENTICATED'::character varying NOT NULL,
    session_generation bigint DEFAULT 1 NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    renew_after timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_renewed_at timestamp with time zone,
    server_key_version integer DEFAULT 1 NOT NULL,
    session_protocol_version integer DEFAULT 2 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_status_check CHECK (((status)::text = ANY ((ARRAY['PARTIAL'::character varying, 'AUTHENTICATED'::character varying, 'EXPIRED'::character varying, 'REVOKED'::character varying, 'LOGGED_OUT'::character varying])::text[])))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    subscription_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider_subscription_id character varying(255) NOT NULL,
    plan_id character varying(50) NOT NULL,
    status character varying(20) NOT NULL,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'PAST_DUE'::character varying, 'CANCELLED'::character varying, 'EXPIRED'::character varying])::text[])))
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    ticket_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    subject character varying(255) NOT NULL,
    category character varying(100) NOT NULL,
    message text NOT NULL,
    status character varying(50) DEFAULT 'OPEN'::character varying NOT NULL,
    file_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'PENDING'::character varying, 'RESOLVED'::character varying, 'CLOSED'::character varying])::text[])))
);


--
-- Name: system_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_versions (
    version_id character varying(50) NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    is_available boolean DEFAULT false NOT NULL,
    download_url text,
    sha256_hash character varying(64),
    release_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_generation_states account_generation_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_generation_states
    ADD CONSTRAINT account_generation_states_pkey PRIMARY KEY (account_id);


--
-- Name: accounts accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_key UNIQUE (email);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (account_id);


--
-- Name: admin_sessions admin_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: admin_users admin_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_email_key UNIQUE (email);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (admin_id);


--
-- Name: authorizations authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorizations
    ADD CONSTRAINT authorizations_pkey PRIMARY KEY (authorization_id);


--
-- Name: automation_account_configs automation_account_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_account_configs
    ADD CONSTRAINT automation_account_configs_pkey PRIMARY KEY (account_id);


--
-- Name: backend_keys backend_keys_key_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backend_keys
    ADD CONSTRAINT backend_keys_key_version_key UNIQUE (key_version);


--
-- Name: backend_keys backend_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backend_keys
    ADD CONSTRAINT backend_keys_pkey PRIMARY KEY (key_id);


--
-- Name: backend_trust_state backend_trust_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backend_trust_state
    ADD CONSTRAINT backend_trust_state_pkey PRIMARY KEY (singleton_guard);


--
-- Name: betting_accounts betting_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.betting_accounts
    ADD CONSTRAINT betting_accounts_pkey PRIMARY KEY (id);


--
-- Name: diagnostic_reports diagnostic_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_reports
    ADD CONSTRAINT diagnostic_reports_pkey PRIMARY KEY (report_id);


--
-- Name: file_transfer_chunks file_transfer_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfer_chunks
    ADD CONSTRAINT file_transfer_chunks_pkey PRIMARY KEY (transfer_id, chunk_index);


--
-- Name: file_transfers file_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_pkey PRIMARY KEY (transfer_id);


--
-- Name: file_transfers file_transfers_remote_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_remote_session_id_key UNIQUE (remote_session_id);


--
-- Name: global_automation_configs global_automation_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_automation_configs
    ADD CONSTRAINT global_automation_configs_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_reference_key UNIQUE (reference);


--
-- Name: licenses licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (license_id);


--
-- Name: machine_session_states machine_session_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_session_states
    ADD CONSTRAINT machine_session_states_pkey PRIMARY KEY (account_id, machine_id);


--
-- Name: machines machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (machine_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: operator_settings operator_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_settings
    ADD CONSTRAINT operator_settings_pkey PRIMARY KEY (account_id);


--
-- Name: outbox_events outbox_events_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (event_id);


--
-- Name: payment_events payment_events_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (event_id);


--
-- Name: payment_events payment_events_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_provider_event_id_key UNIQUE (provider_event_id);


--
-- Name: plan_entitlements plan_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_entitlements
    ADD CONSTRAINT plan_entitlements_pkey PRIMARY KEY (plan_id);


--
-- Name: revocation_circuit_breaker revocation_circuit_breaker_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revocation_circuit_breaker
    ADD CONSTRAINT revocation_circuit_breaker_pkey PRIMARY KEY (window_start);


--
-- Name: scheduled_jobs scheduled_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (job_name);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: security_events security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (event_id);


--
-- Name: server_nonces server_nonces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_nonces
    ADD CONSTRAINT server_nonces_pkey PRIMARY KEY (nonce);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (session_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (subscription_id);


--
-- Name: subscriptions subscriptions_provider_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_provider_subscription_id_key UNIQUE (provider_subscription_id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (ticket_id);


--
-- Name: system_versions system_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_versions
    ADD CONSTRAINT system_versions_pkey PRIMARY KEY (version_id);


--
-- Name: idx_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_email ON public.accounts USING btree (email);


--
-- Name: idx_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_status ON public.accounts USING btree (status);


--
-- Name: idx_authorizations_license; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authorizations_license ON public.authorizations USING btree (license_id);


--
-- Name: idx_authorizations_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authorizations_session ON public.authorizations USING btree (session_id);


--
-- Name: idx_authorizations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authorizations_status ON public.authorizations USING btree (status);


--
-- Name: idx_betting_accounts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_betting_accounts_account ON public.betting_accounts USING btree (account_id);


--
-- Name: idx_betting_accounts_backend_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_betting_accounts_backend_state ON public.betting_accounts USING btree (backend_state);


--
-- Name: idx_betting_accounts_platform_username; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_betting_accounts_platform_username ON public.betting_accounts USING btree (account_id, lower((platform_display_name)::text), lower((account_username)::text));


--
-- Name: idx_diagnostic_reports_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_reports_account ON public.diagnostic_reports USING btree (account_id);


--
-- Name: idx_file_transfers_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_transfers_session ON public.file_transfers USING btree (session_id);


--
-- Name: idx_invoices_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_account ON public.invoices USING btree (account_id);


--
-- Name: idx_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_status ON public.invoices USING btree (status);


--
-- Name: idx_licenses_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_account ON public.licenses USING btree (account_id);


--
-- Name: idx_licenses_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_status ON public.licenses USING btree (status);


--
-- Name: idx_machines_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_machines_account ON public.machines USING btree (account_id);


--
-- Name: idx_machines_install_pubkey; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_machines_install_pubkey ON public.machines USING btree (installation_id, public_key_hex);


--
-- Name: idx_machines_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_machines_installation ON public.machines USING btree (installation_id);


--
-- Name: idx_machines_pubkey; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_machines_pubkey ON public.machines USING btree (public_key_hex);


--
-- Name: idx_nonces_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nonces_received ON public.server_nonces USING btree (received_at);


--
-- Name: idx_notifications_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_account ON public.notifications USING btree (account_id);


--
-- Name: idx_notifications_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created ON public.notifications USING btree (created_at DESC);


--
-- Name: idx_notifications_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_read ON public.notifications USING btree (account_id, is_read);


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox_events USING btree (status, next_attempt_at) WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying])::text[]));


--
-- Name: idx_outbox_stale_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_stale_lease ON public.outbox_events USING btree (lease_expires_at) WHERE ((status)::text = 'PROCESSING'::text);


--
-- Name: idx_security_events_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_account ON public.security_events USING btree (account_id);


--
-- Name: idx_security_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_created ON public.security_events USING btree (created_at);


--
-- Name: idx_security_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_type ON public.security_events USING btree (event_type);


--
-- Name: idx_sessions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_account ON public.sessions USING btree (account_id);


--
-- Name: idx_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_expires ON public.sessions USING btree (expires_at);


--
-- Name: idx_sessions_machine_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sessions_machine_active ON public.sessions USING btree (machine_id) WHERE ((status)::text = 'AUTHENTICATED'::text);


--
-- Name: idx_sessions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_status ON public.sessions USING btree (status);


--
-- Name: idx_support_tickets_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_account ON public.support_tickets USING btree (account_id);


--
-- Name: idx_support_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_status ON public.support_tickets USING btree (status);


--
-- Name: account_generation_states trg_account_generation_states_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_account_generation_states_monotonic BEFORE UPDATE ON public.account_generation_states FOR EACH ROW EXECUTE FUNCTION public.reject_license_revision_decrease();


--
-- Name: machine_session_states trg_machine_session_states_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_machine_session_states_monotonic BEFORE UPDATE ON public.machine_session_states FOR EACH ROW EXECUTE FUNCTION public.reject_generation_decrease();


--
-- Name: machines trg_machines_monotonic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_machines_monotonic BEFORE UPDATE ON public.machines FOR EACH ROW EXECUTE FUNCTION public.reject_machine_generation_decrease();


--
-- Name: account_generation_states account_generation_states_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_generation_states
    ADD CONSTRAINT account_generation_states_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: admin_sessions admin_sessions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admin_users(admin_id) ON DELETE CASCADE;


--
-- Name: authorizations authorizations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorizations
    ADD CONSTRAINT authorizations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: authorizations authorizations_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorizations
    ADD CONSTRAINT authorizations_license_id_fkey FOREIGN KEY (license_id) REFERENCES public.licenses(license_id);


--
-- Name: authorizations authorizations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorizations
    ADD CONSTRAINT authorizations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(session_id) ON DELETE CASCADE;


--
-- Name: automation_account_configs automation_account_configs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_account_configs
    ADD CONSTRAINT automation_account_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.betting_accounts(id) ON DELETE CASCADE;


--
-- Name: betting_accounts betting_accounts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.betting_accounts
    ADD CONSTRAINT betting_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: diagnostic_reports diagnostic_reports_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_reports
    ADD CONSTRAINT diagnostic_reports_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: diagnostic_reports diagnostic_reports_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_reports
    ADD CONSTRAINT diagnostic_reports_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;


--
-- Name: file_transfer_chunks file_transfer_chunks_transfer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfer_chunks
    ADD CONSTRAINT file_transfer_chunks_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.file_transfers(transfer_id) ON DELETE CASCADE;


--
-- Name: file_transfers file_transfers_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(session_id) ON DELETE CASCADE;


--
-- Name: global_automation_configs global_automation_configs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_automation_configs
    ADD CONSTRAINT global_automation_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: invoices invoices_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: licenses licenses_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: licenses licenses_machine_binding_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_machine_binding_fkey FOREIGN KEY (machine_binding) REFERENCES public.machines(machine_id);


--
-- Name: licenses licenses_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan_entitlements(plan_id);


--
-- Name: machine_session_states machine_session_states_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_session_states
    ADD CONSTRAINT machine_session_states_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: machine_session_states machine_session_states_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine_session_states
    ADD CONSTRAINT machine_session_states_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE CASCADE;


--
-- Name: machines machines_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: notifications notifications_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: operator_settings operator_settings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_settings
    ADD CONSTRAINT operator_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: payment_events payment_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: payment_events payment_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(subscription_id);


--
-- Name: revocation_circuit_breaker revocation_circuit_breaker_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revocation_circuit_breaker
    ADD CONSTRAINT revocation_circuit_breaker_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES public.admin_users(admin_id);


--
-- Name: security_events security_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE SET NULL;


--
-- Name: security_events security_events_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;


--
-- Name: security_events security_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(session_id) ON DELETE SET NULL;


--
-- Name: sessions sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: sessions sessions_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plan_entitlements(plan_id);


--
-- Name: support_tickets support_tickets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict vdMhMF6stglJc6yts0ND1dXRdwxz0eofE4GZ6i9gTZEsmggH2tyk5HZJ6ThdHry

