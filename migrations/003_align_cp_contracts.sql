-- Migration 003: Control Plane Interoperability & Schema Hardening
-- Allows machines to register on cold boot before operator login (account_id NULLable initially)
-- Allows installation_id to store string hardware identifiers (inst_hw_...)

ALTER TABLE machines ALTER COLUMN installation_id TYPE VARCHAR(255);
ALTER TABLE machines ALTER COLUMN account_id DROP NOT NULL;

-- Ensure indexes for fast lookup during envelope validation
CREATE INDEX IF NOT EXISTS idx_machines_installation_str ON machines(installation_id);
CREATE INDEX IF NOT EXISTS idx_machines_pubkey_hex ON machines(public_key_hex);

-- Ensure pgcrypto extension is active
CREATE EXTENSION IF NOT EXISTS pgcrypto;
