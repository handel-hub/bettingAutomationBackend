-- Removed for pglite compat, gen_random_uuid is builtin in PG 13+

CREATE TABLE accounts (
  account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  credentials_hash VARCHAR(512) NOT NULL,             -- Argon2id
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','SUSPENDED','DELETED')),
  lockout_count INTEGER NOT NULL DEFAULT 0,
  lockout_expires_at TIMESTAMPTZ,                     -- renamed from lockout_until (B-04 clarity fix)
  last_event_hash VARCHAR(64) NOT NULL DEFAULT encode(sha256('GENESIS'::bytea), 'hex'),  -- CRIT-07 fix
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_email ON accounts(email);
CREATE INDEX idx_accounts_status ON accounts(status);

CREATE TABLE machines (
  machine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  public_key_hex VARCHAR(64) NOT NULL,
  -- B-09 fix: CP-only pre-registration states removed
  status VARCHAR(30) NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('REGISTERED','VERIFIED','CORRUPTED','REPLACEMENT_REQUIRED','RE_VERIFICATION_REQUIRED','REVOKED')),
  machine_generation BIGINT NOT NULL DEFAULT 1,        -- DEC-06: counters start at 1
  descriptor JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_machines_account ON machines(account_id);
CREATE INDEX idx_machines_installation ON machines(installation_id);
CREATE UNIQUE INDEX idx_machines_pubkey ON machines(public_key_hex);
CREATE UNIQUE INDEX idx_machines_install_pubkey ON machines(installation_id, public_key_hex); -- idempotent registration

CREATE TABLE sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
  -- B-08/B-11 fix: CP-only pre-row states removed, PARTIAL added for deferred-authorization auth (§14.5)
  status VARCHAR(20) NOT NULL DEFAULT 'AUTHENTICATED'
    CHECK (status IN ('PARTIAL','AUTHENTICATED','EXPIRED','REVOKED','LOGGED_OUT')),
  session_generation BIGINT NOT NULL DEFAULT 1,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renew_after TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_renewed_at TIMESTAMPTZ,
  server_key_version INTEGER NOT NULL DEFAULT 1,
  session_protocol_version INTEGER NOT NULL DEFAULT 2,  -- protocol v2 default
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_sessions_machine_active ON sessions(machine_id) WHERE status = 'AUTHENTICATED'; -- DEC-03: single active session/machine
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE plan_entitlements (             -- NEW: resolves DB-03 (no entitlements table)
  plan_id VARCHAR(50) PRIMARY KEY,           -- 'BASE' | 'PRO' | 'ENTERPRISE'
  capabilities JSONB NOT NULL,               -- union-set members (§3 item 8)
  limits JSONB NOT NULL,                     -- e.g. { "max_concurrent_browsers": 5 }
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE licenses (
  license_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_binding UUID REFERENCES machines(machine_id),       -- EV-13 fix
  plan_id VARCHAR(50) NOT NULL REFERENCES plan_entitlements(plan_id),
  status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('UNKNOWN','VALID','EXPIRING','EXPIRED','REVOKED','SUSPENDED','INVALID')),
  capabilities JSONB NOT NULL,               -- materialized from plan_entitlements at issue time
  limits JSONB NOT NULL,
  license_revision BIGINT NOT NULL DEFAULT 1,   -- advances ONLY when the license itself changes (Freeze Audit P0-6) — never from authorization/resolve
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),            -- EV-13 fix
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,                                     -- EV-13 fix
  last_verified_at TIMESTAMPTZ,                                -- EV-13 fix
  keygen_license_id VARCHAR(255),                              -- EV-13 fix
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: an earlier draft also carried a `backend_revision` column duplicating `license_revision` with no
  -- distinct meaning and no other reference anywhere in this plan. Removed (Freeze Audit P1-4) rather than
  -- retained unused — if a genuinely separate "administrative touch, not an entitlement change" counter is
  -- ever needed, it must be named and specified as its own decision, not silently reintroduced here.
);
CREATE INDEX idx_licenses_account ON licenses(account_id);
CREATE INDEX idx_licenses_status ON licenses(status);

CREATE TABLE authorizations (
  authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  license_id UUID REFERENCES licenses(license_id),      -- EV-14/B-06 fix: enables targeted cascade; resolves cleanly now that `licenses` is created first (Freeze Audit P0-1)
  status VARCHAR(20) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','EXPIRED','REVOKED','SUPERSEDED')),
  capability_set JSONB NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  authorization_revision BIGINT NOT NULL DEFAULT 1,
  observed_license_revision BIGINT NOT NULL,   -- stamped from licenses.license_revision at resolve time; read-only copy, not a second source of truth
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_authorizations_session ON authorizations(session_id);
CREATE INDEX idx_authorizations_license ON authorizations(license_id);
CREATE INDEX idx_authorizations_status ON authorizations(status);


-- Account-scoped: license_revision belongs to the account, not a specific machine
CREATE TABLE account_generation_states (
  account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  license_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Machine-scoped: session/authorization/machine generation are per (account, machine)
CREATE TABLE machine_session_states (
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
  session_generation BIGINT NOT NULL DEFAULT 1,
  authorization_revision BIGINT NOT NULL DEFAULT 1,
  machine_generation BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, machine_id)
);

-- Global: server_trust_version tracks Backend signing-key epoch (in Postgres — fine, it's not
-- the restore-detection mechanism). server_epoch (CRIT-05) is intentionally NOT here — see §5.3.
CREATE TABLE backend_trust_state (
  singleton_guard BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton_guard),
  server_trust_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO backend_trust_state (singleton_guard) VALUES (true);


CREATE OR REPLACE FUNCTION reject_generation_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.session_generation < OLD.session_generation
     OR NEW.authorization_revision < OLD.authorization_revision
     OR NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'generation counter decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_machine_session_states_monotonic
  BEFORE UPDATE ON machine_session_states FOR EACH ROW EXECUTE FUNCTION reject_generation_decrease();

CREATE OR REPLACE FUNCTION reject_license_revision_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.license_revision < OLD.license_revision THEN
    RAISE EXCEPTION 'license_revision decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_account_generation_states_monotonic
  BEFORE UPDATE ON account_generation_states FOR EACH ROW EXECUTE FUNCTION reject_license_revision_decrease();

-- Freeze Audit P2-9: the same protection is extended to machines.machine_generation directly (previously
-- only machine_session_states.machine_generation — a mirrored copy — was trigger-protected).
CREATE OR REPLACE FUNCTION reject_machine_generation_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'machine_generation decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_machines_monotonic
  BEFORE UPDATE ON machines FOR EACH ROW EXECUTE FUNCTION reject_machine_generation_decrease();


CREATE TABLE security_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(account_id) ON DELETE SET NULL,
  machine_id UUID REFERENCES machines(machine_id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(session_id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (        -- DB-05 fix: full 35+ type list
    'LOGIN_SUCCESS','LOGIN_FAILURE','SESSION_RENEWED','SESSION_EXPIRED','SESSION_REVOKED',
    'LICENSE_CHANGED','LICENSE_REVOKED','LICENSE_CREATED','LICENSE_SUSPENDED','LICENSE_REACTIVATED',
    'MACHINE_IDENTITY_CHANGED','MACHINE_REGISTERED','MACHINE_REVOKED','MACHINE_CLONE_DETECTED',
    'KEY_ROTATED','SERVER_KEY_CHANGED','INTEGRITY_FAILURE','ROLLBACK_DETECTED','CLOCK_ANOMALY',
    'STORAGE_CORRUPTION','UNAUTHORIZED_IPC','AUTHORIZATION_GRANTED','AUTHORIZATION_REVOKED',
    'AUTHORIZATION_EXPIRED','PAYMENT_RECEIVED','PAYMENT_FAILED','PAYMENT_REFUNDED','ACCOUNT_LOCKED',
    'ACCOUNT_SUSPENDED','ACCOUNT_REINSTATED','ADMIN_ACTION','CIRCUIT_BREAKER_TRIGGERED',
    'CIRCUIT_BREAKER_OVERRIDDEN','RECONCILIATION_PERFORMED','GENERATION_COUNTER_FORGERY','REVOCATION_CASCADE'
  )),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER')),
  actor_id VARCHAR(255),
  session_generation BIGINT, machine_generation BIGINT, authorization_revision BIGINT,
  transaction_id UUID,
  old_state VARCHAR(50), new_state VARCHAR(50),
  result VARCHAR(20) NOT NULL CHECK (result IN ('SUCCESS','FAILURE','DENIED','ERROR')),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,     -- redacted before insert (Phase 16)
  prev_hash VARCHAR(64) NOT NULL,                  -- CRIT-07 fix
  event_hash VARCHAR(64) NOT NULL,                 -- CRIT-07 fix
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON security_events FROM PUBLIC;   -- INV-20
CREATE INDEX idx_security_events_account ON security_events(account_id);
CREATE INDEX idx_security_events_type ON security_events(event_type);
CREATE INDEX idx_security_events_created ON security_events(created_at);

-- NOTE (Freeze Audit P1-1): an earlier draft also defined a `pending_transactions` table
-- (CREATED → SENT → RESPONSE_PENDING → COMMITTED → RETRY_PENDING → FAILED) intended as a general
-- unknown-outcome ledger. It was never wired into any phase's workflow — nothing ever created,
-- transitioned, or cleaned up a row — so it could never hold data as specified. Rather than leave
-- unused infrastructure with no owner, it is removed: unknown-outcome recovery for every operation
-- in this plan is fully covered without it, by the per-operation idempotency registry (§6.3) plus
-- generation-mismatch-triggered reconciliation (§4 Phase 15) plus outbox idempotency keys (§6.2/§10).
-- If a future operation genuinely needs "let the CP ask what happened to a specific past request"
-- beyond what those three mechanisms already provide, that is new design work requiring its own
-- decision — not a table to silently resurrect.

CREATE TABLE server_nonces (
  nonce VARCHAR(128) PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  epoch BIGINT NOT NULL
);
CREATE INDEX idx_nonces_received ON server_nonces(received_at);  -- purge job target (60s TTL)

CREATE TABLE outbox_events (                        -- CRIT-03 fix, lease mechanism added per Freeze Audit P0-3
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,                  -- 'CREATE_LICENSE' | 'REVOKE_LICENSE' | 'REVOCATION_NOTICE' | ...
  payload JSONB NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  claimed_at TIMESTAMPTZ,                           -- NEW: when a worker claimed this row
  lease_expires_at TIMESTAMPTZ,                     -- NEW: claim is void after this instant — enables reclaim
  worker_id VARCHAR(100),                           -- NEW: which worker instance holds the current claim
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, next_attempt_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX idx_outbox_stale_lease ON outbox_events(lease_expires_at) WHERE status = 'PROCESSING';

CREATE TABLE file_transfers (
  transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  remote_session_id UUID NOT NULL UNIQUE,
  file_id VARCHAR(255) NOT NULL,
  total_size BIGINT NOT NULL,
  total_chunks INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  content_hash VARCHAR(128) NOT NULL,
  hash_algorithm VARCHAR(20) NOT NULL DEFAULT 'sha256',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  acked_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,   -- EV-09 fix: [[start,end],...] ranges
  status VARCHAR(20) NOT NULL DEFAULT 'INITIALIZING'
    CHECK (status IN ('INITIALIZING','UPLOADING','COMPLETING','COMPLETED','CANCELLED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_file_transfers_session ON file_transfers(session_id);

CREATE TABLE file_transfer_chunks (
  transfer_id UUID NOT NULL REFERENCES file_transfers(transfer_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_offset BIGINT NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_hash VARCHAR(128) NOT NULL,
  acked BOOLEAN NOT NULL DEFAULT false,
  acked_at TIMESTAMPTZ,
  PRIMARY KEY (transfer_id, chunk_index)
);

CREATE TABLE subscriptions (                          -- moved ahead of payment_events (Freeze Audit P2-2) so
                                                       -- payment_events.subscription_id can carry a real FK
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  provider_subscription_id VARCHAR(255) NOT NULL UNIQUE,
  plan_id VARCHAR(50) NOT NULL REFERENCES plan_entitlements(plan_id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id VARCHAR(255) NOT NULL UNIQUE,
  provider VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(subscription_id),   -- Freeze Audit P2-2: now a real FK
  amount DECIMAL(10,2), currency VARCHAR(3),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED')),
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE scheduled_jobs (                        -- NEW: LP-04 fix support
  job_name VARCHAR(100) PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ
);

CREATE TABLE admin_users (
  admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  credentials_hash VARCHAR(512) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('SUPER_ADMIN','LICENSE_ADMIN','SUPPORT','AUDIT')),
  mfa_secret VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admin_users(admin_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocation_circuit_breaker (   -- R-03 fix (persisted, not in-memory); moved after admin_users
                                             -- so overridden_by resolves cleanly (Freeze Audit P0-2).
                                             -- Fixed one-minute window, not a sliding/rolling window
                                             -- (Freeze Audit P1-2 / DEC-16) — window_start identifies the
                                             -- window (date_trunc('minute', now())); a revocation clustered
                                             -- at a window boundary can, in the worst case, allow up to 2x
                                             -- CIRCUIT_BREAKER_THRESHOLD before tripping. Accepted tradeoff
                                             -- for implementation simplicity over a true sliding-window log.
  window_start TIMESTAMPTZ PRIMARY KEY,
  revocation_count INTEGER NOT NULL DEFAULT 0,
  tripped BOOLEAN NOT NULL DEFAULT false,
  overridden_by UUID REFERENCES admin_users(admin_id),
  overridden_reason TEXT
);

CREATE TABLE backend_keys (
  key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_version INTEGER NOT NULL UNIQUE,
  public_key_hex VARCHAR(64) NOT NULL,
  -- private key material NEVER stored here; KMS/HSM only
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('GENERATED','ACTIVE','ROTATION_PENDING','ROTATED','RETIRED','DESTROYED','KEY_COMPROMISED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ, retired_at TIMESTAMPTZ, destroyed_at TIMESTAMPTZ
);
