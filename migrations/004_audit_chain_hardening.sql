-- Migration 004: Add last_global_event_hash to backend_trust_state for global audit chain
ALTER TABLE backend_trust_state ADD COLUMN IF NOT EXISTS last_global_event_hash VARCHAR(128) DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
