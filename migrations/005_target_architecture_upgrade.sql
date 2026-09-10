-- Migration 005: Target Architecture Upgrade & Contract Specification Conformance
-- Implements authoritative catalogs (subscription_plans, platform_registry, support_channels),
-- enhanced fiscal invoicing (subtotal, tax_amount, tax_rate, plan_name, billing_interval),
-- dynamic platform validation (drops rigid platform CHECK constraint), and audit telemetry ingestion.

-- 1. Subscription Plans Catalog (Master Catalog for CNT-BILL-PLANS-01 & 12-Point Flexibility)
CREATE TABLE IF NOT EXISTS subscription_plans (
  plan_id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  tagline TEXT NOT NULL,
  description TEXT NOT NULL,
  monthly_price NUMERIC(12,2) NOT NULL,
  annual_price NUMERIC(12,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
  currency_symbol VARCHAR(10) NOT NULL DEFAULT '₦',
  annual_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0750,
  is_popular BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed authoritative subscription plans
INSERT INTO subscription_plans (
  plan_id, name, tagline, description, monthly_price, annual_price, currency, currency_symbol,
  annual_discount_percent, tax_rate, is_popular, is_active, sort_order, features, entitlements
) VALUES 
  (
    'starter',
    'Starter',
    'For individual operators getting started',
    'Essential single-market trading tools with basic browser allocation.',
    5000.00,
    48000.00,
    'NGN',
    '₦',
    20.00,
    0.0750,
    false,
    true,
    1,
    '["Up to 3 Connected Accounts", "Standard Execution Speed", "Email Alert Notifications"]'::jsonb,
    '{"maxAccounts": 3, "maxConcurrentBrowsers": 2, "allowedPlatformIds": ["sportybet", "bet9ja", "betking", "1xbet"], "stealthAntidetectEnabled": false, "priorityScanning": false}'::jsonb
  ),
  (
    'pro',
    'Pro',
    'Optimal for professional day arbitrageurs',
    'Advanced multi-bookmaker routing, dedicated proxy chaining, and stealth execution.',
    10000.00,
    96000.00,
    'NGN',
    '₦',
    20.00,
    0.0750,
    true,
    true,
    2,
    '["Up to 10 Connected Accounts", "High-Priority Odds Scanning", "Stealth Antidetect Profiling"]'::jsonb,
    '{"maxAccounts": 10, "maxConcurrentBrowsers": 6, "allowedPlatformIds": ["sportybet", "bet9ja", "betking", "1xbet"], "stealthAntidetectEnabled": true, "priorityScanning": true}'::jsonb
  ),
  (
    'elite',
    'Elite Syndicate',
    'High-volume syndicate operations',
    'Unlimited accounts, multi-VPS clustering, sub-100ms odds routing.',
    25000.00,
    240000.00,
    'NGN',
    '₦',
    20.00,
    0.0750,
    false,
    true,
    3,
    '["25 Connected Accounts", "Custom Binary Antidetect", "Direct Bookmaker Ingress"]'::jsonb,
    '{"maxAccounts": 25, "maxConcurrentBrowsers": 15, "allowedPlatformIds": ["sportybet", "bet9ja", "betking", "1xbet", "betway", "pinnacle", "paripesa"], "stealthAntidetectEnabled": true, "priorityScanning": true}'::jsonb
  )
ON CONFLICT (plan_id) DO UPDATE SET
  name = EXCLUDED.name,
  tagline = EXCLUDED.tagline,
  description = EXCLUDED.description,
  monthly_price = EXCLUDED.monthly_price,
  annual_price = EXCLUDED.annual_price,
  features = EXCLUDED.features,
  entitlements = EXCLUDED.entitlements,
  updated_at = now();

-- Ensure plan_entitlements has matching records for backward compatibility
INSERT INTO plan_entitlements (plan_id, capabilities, limits)
VALUES 
  ('starter', '["CAP_TACTICAL_BET", "CAP_CASH_OUT"]'::jsonb, '{"max_machines": 2, "max_concurrent_browsers": 2, "price": 5000, "interval": "Monthly"}'::jsonb),
  ('pro', '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD", "CAP_TACTICAL_BET", "CAP_CASH_OUT"]'::jsonb, '{"max_machines": 5, "max_concurrent_browsers": 6, "price": 10000, "interval": "Monthly"}'::jsonb),
  ('elite', '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD", "CAP_TACTICAL_BET", "CAP_CASH_OUT", "CAP_STEALTH", "CAP_PRIORITY"]'::jsonb, '{"max_machines": 10, "max_concurrent_browsers": 15, "price": 25000, "interval": "Monthly"}'::jsonb)
ON CONFLICT (plan_id) DO UPDATE SET
  capabilities = EXCLUDED.capabilities,
  limits = EXCLUDED.limits;

-- 2. Platform Registry (Master Ecosystem Catalog for CNT-PLAT-REG-01)
CREATE TABLE IF NOT EXISTS platform_registry (
  id VARCHAR(50) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  icon_url TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE', 'DEGRADED', 'MAINTENANCE')),
  is_available BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed authoritative platforms
INSERT INTO platform_registry (id, display_name, icon_url, status, is_available, sort_order)
VALUES 
  ('sportybet', 'SportyBet', 'https://assets.betting-automation.internal/platforms/sportybet.svg', 'ONLINE', true, 1),
  ('bet9ja', 'Bet9ja', 'https://assets.betting-automation.internal/platforms/bet9ja.svg', 'ONLINE', true, 2),
  ('betking', 'BetKing', 'https://assets.betting-automation.internal/platforms/betking.svg', 'ONLINE', true, 3),
  ('1xbet', '1xBet', 'https://assets.betting-automation.internal/platforms/1xbet.svg', 'ONLINE', true, 4),
  ('betway', 'Betway', 'https://assets.betting-automation.internal/platforms/betway.svg', 'ONLINE', true, 5),
  ('pinnacle', 'Pinnacle', 'https://assets.betting-automation.internal/platforms/pinnacle.svg', 'ONLINE', true, 6),
  ('paripesa', 'PariPesa', 'https://assets.betting-automation.internal/platforms/paripesa.svg', 'MAINTENANCE', false, 7)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  icon_url = EXCLUDED.icon_url,
  status = EXCLUDED.status,
  is_available = EXCLUDED.is_available,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- Drop rigid check constraint on betting_accounts to enable dynamic bookmaker registration
ALTER TABLE betting_accounts DROP CONSTRAINT IF EXISTS betting_accounts_platform_display_name_check;

-- 3. Customer Support Channels (Dynamic Support Channels for CNT-CARE-SNAP-01)
CREATE TABLE IF NOT EXISTS support_channels (
  id VARCHAR(50) PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('INTERNAL_ROUTE', 'EXTERNAL_LINK')),
  action_target TEXT NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed dynamic contact methods
INSERT INTO support_channels (id, title, description, action_type, action_target, is_available, sort_order)
VALUES
  ('ticket', 'Support Ticket', 'Create a priority support request with attached diagnostic logs', 'INTERNAL_ROUTE', '/workspace/support/tickets/new', true, 1),
  ('discord', 'Discord Operator Community', 'Engage with professional arbitrage engineers & market strategists', 'EXTERNAL_LINK', 'https://discord.gg/betting-automation', true, 2),
  ('telegram', 'Telegram Channel', 'Real-time alert feeds and operator network', 'EXTERNAL_LINK', 'https://t.me/betting_automation_operators', true, 3)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  action_type = EXCLUDED.action_type,
  action_target = EXCLUDED.action_target,
  is_available = EXCLUDED.is_available,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- 4. Invoices Fiscal Enhancements (CNT-BILL-SNAP-01, Section 16.2 & 17.1)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,4) DEFAULT 0.0750;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS plan_name VARCHAR(100);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(50) DEFAULT 'Monthly';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(10) DEFAULT '₦';

-- Backfill any existing invoice records with 7.5% statutory VAT calculation
UPDATE invoices 
SET 
  subtotal = ROUND(amount / (1 + COALESCE(tax_rate, 0.0750)), 2),
  tax_amount = amount - ROUND(amount / (1 + COALESCE(tax_rate, 0.0750)), 2),
  plan_name = COALESCE(plan_name, 'Pro'),
  billing_interval = COALESCE(billing_interval, 'Monthly'),
  currency_symbol = '₦'
WHERE subtotal IS NULL;

-- 5. Arbitrage Audit Telemetry Storage (UP-ACP-AUDIT-LOG Ingestion)
CREATE TABLE IF NOT EXISTS arbitrage_audit_telemetry (
  telemetry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID REFERENCES machines(machine_id) ON DELETE SET NULL,
  markets_scanned INTEGER NOT NULL DEFAULT 0,
  execution_latency_ms INTEGER,
  orders_accepted INTEGER NOT NULL DEFAULT 0,
  orders_rejected INTEGER NOT NULL DEFAULT 0,
  net_profit_margin NUMERIC(12,2),
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_account ON arbitrage_audit_telemetry(account_id, recorded_at DESC);
