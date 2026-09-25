-- Migration 002: Full Domain Persistence for Betting Automation Suite
-- Implements tables for Domains 1-7: Betting Accounts, Automation Configs, Invoices, Operator Settings, Notifications, Support, and System Versions

-- 1. Betting Accounts (Domain 2)
CREATE TABLE IF NOT EXISTS betting_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  platform_display_name VARCHAR(100) NOT NULL CHECK (platform_display_name IN (
    'SportyBet', 'Bet9ja', 'BetKing', '1xBet', 'Betway', 'Bet365', 'Pinnacle'
  )),
  account_username VARCHAR(255) NOT NULL,
  account_password_encrypted TEXT NOT NULL,
  password_iv VARCHAR(32) NOT NULL,
  password_tag VARCHAR(32) NOT NULL,
  avatar_url TEXT,
  backend_state VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (backend_state IN ('ACTIVE', 'SUSPENDED', 'LOCKED', 'ARCHIVED')),
  presentation_category VARCHAR(50) NOT NULL DEFAULT 'Healthy' CHECK (presentation_category IN ('Healthy', 'Warning', 'Critical', 'Neutral')),
  status_description TEXT NOT NULL DEFAULT 'Account registered and ready for activation',
  warning_message TEXT,
  is_selectable BOOLEAN NOT NULL DEFAULT true,
  available_actions JSONB NOT NULL DEFAULT '["ACTIVATE", "DELETE"]'::jsonb,
  pending_operation JSONB,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_synchronization TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_betting_accounts_platform_username 
  ON betting_accounts(account_id, lower(platform_display_name), lower(account_username));
CREATE INDEX IF NOT EXISTS idx_betting_accounts_account ON betting_accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_betting_accounts_backend_state ON betting_accounts(backend_state);

-- 2. Automation Account Configs & State (Domain 1)
CREATE TABLE IF NOT EXISTS automation_account_configs (
  account_id UUID PRIMARY KEY REFERENCES betting_accounts(id) ON DELETE CASCADE,
  bet_cycle_enabled BOOLEAN NOT NULL DEFAULT true,
  pricing_source VARCHAR(20) NOT NULL DEFAULT 'GLOBAL' CHECK (pricing_source IN ('GLOBAL', 'CUSTOM')),
  risk_source VARCHAR(20) NOT NULL DEFAULT 'GLOBAL' CHECK (risk_source IN ('GLOBAL', 'CUSTOM')),
  rebet_source VARCHAR(20) NOT NULL DEFAULT 'GLOBAL' CHECK (rebet_source IN ('GLOBAL', 'CUSTOM')),
  custom_pricing JSONB,
  custom_risk JSONB,
  custom_rebet JSONB,
  browser_status VARCHAR(50) NOT NULL DEFAULT 'STOPPED' CHECK (browser_status IN ('ACTIVE', 'STOPPED', 'LAUNCHING', 'CRASHED')),
  account_status VARCHAR(50) NOT NULL DEFAULT 'IDLE' CHECK (account_status IN ('IDLE', 'IN_USE', 'PROCESSING', 'DEGRADED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Global Automation Configs (Domain 1)
CREATE TABLE IF NOT EXISTS global_automation_configs (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'primary',
  account_id UUID REFERENCES accounts(account_id) ON DELETE CASCADE,
  pricing JSONB NOT NULL,
  risk JSONB NOT NULL,
  rebet JSONB NOT NULL,
  proxy JSONB NOT NULL,
  execution JSONB NOT NULL,
  browser_spawning JSONB NOT NULL,
  advanced_runtime JSONB NOT NULL,
  lifecycle VARCHAR(50) NOT NULL DEFAULT 'STOPPED' CHECK (lifecycle IN ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR_DEGRADED')),
  lifecycle_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default global configuration if not exists
INSERT INTO global_automation_configs (
  id, pricing, risk, rebet, proxy, execution, browser_spawning, advanced_runtime, lifecycle
) VALUES (
  'primary',
  '{
    "mode": "PROFIT_TARGET",
    "baseStake": 100,
    "targetProfit": 30,
    "minimumAcceptableProfit": 0,
    "resolutionStrategy": "CLAMP_THEN_REDUCE_PROFIT",
    "platformIncrement": 1,
    "selectionPreference": "ROUND_NUMBERS",
    "restorePolicyOnRebet": true
  }'::jsonb,
  '{
    "autoAcceptOddsChanges": false,
    "maxStake": 10000,
    "minimumStake": 10,
    "abortOnMarketSuspend": true
  }'::jsonb,
  '{
    "maxRebetAttempts": 3,
    "restorePolicyOnRebet": true
  }'::jsonb,
  '{
    "proxyFailureMode": "strict",
    "proxyAllocationMode": "dedicated",
    "maxAccountsPerProxy": 5,
    "masterUseProxy": false
  }'::jsonb,
  '{
    "timeouts": {
      "resultTimeoutMs": 30000,
      "navigationTimeoutMs": 10000,
      "loginTimeoutMs": 15000,
      "decisionFreshnessTTLMs": 3000,
      "reconciliationTimeoutMs": 120000
    },
    "retries": {
      "maxExecutionRetries": 3,
      "maxRecoveryAttempts": 3,
      "recoveryBaseDelayMs": 2000
    },
    "keyboardTypingDelayMs": 250,
    "maxRecordedActions": 1000
  }'::jsonb,
  '{
    "maxAccountsToSpawn": 2,
    "slaveMode": "headless",
    "masterUseProxy": false,
    "debugSlowMo": 0
  }'::jsonb,
  '{
    "useStealthPlugin": true,
    "browserBinary": "chrome",
    "randomizeUserAgent": true,
    "blockWebRTC": true,
    "matchProxyTimezone": true,
    "canvasSpoofing": true
  }'::jsonb,
  'STOPPED'
) ON CONFLICT (id) DO NOTHING;

-- 4. Invoices (Domain 3)
CREATE TABLE IF NOT EXISTS invoices (
  id VARCHAR(100) PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  reference VARCHAR(255) UNIQUE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
  status VARCHAR(50) NOT NULL CHECK (status IN ('Paid', 'Failed', 'Pending')),
  paid_at TIMESTAMPTZ,
  receipt_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- 5. Operator Settings (Domain 4)
CREATE TABLE IF NOT EXISTS operator_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'Operator',
  avatar_url TEXT,
  pending_email VARCHAR(255),
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret VARCHAR(255),
  automation_preferences JSONB NOT NULL DEFAULT '{
    "defaultExecutionMode": "auto",
    "maxConcurrentRuns": 2
  }'::jsonb,
  notification_preferences JSONB NOT NULL DEFAULT '{
    "emailAlerts": true,
    "pushAlerts": true,
    "weeklyReport": false
  }'::jsonb,
  presentation_preferences JSONB NOT NULL DEFAULT '{
    "theme": "system",
    "density": "comfortable"
  }'::jsonb,
  account_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'PENDING_DELETION')),
  deletion_scheduled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Notifications Hub (Domain 5)
CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(100) PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  severity VARCHAR(50) NOT NULL CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO', 'SUCCESS')),
  category VARCHAR(50) NOT NULL CHECK (category IN ('AUTOMATION', 'ACCOUNT', 'SYSTEM', 'SECURITY')),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(account_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- 7. Customer Care & Diagnostics (Domain 7)
CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  subject VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED')),
  file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_account ON support_tickets(account_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS diagnostic_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID REFERENCES machines(machine_id) ON DELETE SET NULL,
  telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  recent_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_reports_account ON diagnostic_reports(account_id);

-- 8. System Updates & Version Manifest (Domain 6)
CREATE TABLE IF NOT EXISTS system_versions (
  version_id VARCHAR(50) PRIMARY KEY,
  is_current BOOLEAN NOT NULL DEFAULT false,
  is_available BOOLEAN NOT NULL DEFAULT false,
  download_url TEXT,
  sha256_hash VARCHAR(64),
  release_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_versions (version_id, is_current, is_available, download_url, release_notes)
VALUES 
  ('v0.1.0-alpha', true, false, NULL, 'Initial alpha release with core automation and control plane mediation'),
  ('v0.2.0', false, true, 'https://releases.bettingautomation.io/binaries/v0.2.0-win64.zip', 'Production hardening, stealth plugin upgrades, and multi-bookmaker odds engine')
ON CONFLICT (version_id) DO NOTHING;

-- Seed default PRO plan into plan_entitlements if missing
INSERT INTO plan_entitlements (plan_id, capabilities, limits)
VALUES (
  'PRO',
  '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD", "CAP_TACTICAL_BET", "CAP_CASH_OUT"]'::jsonb,
  '{"max_machines": 5, "max_concurrent_browsers": 5, "risk_tier": "LOW", "price": 10000, "interval": "Monthly"}'::jsonb
) ON CONFLICT (plan_id) DO UPDATE 
SET capabilities = EXCLUDED.capabilities, limits = EXCLUDED.limits;
