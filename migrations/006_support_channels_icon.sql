-- Migration 006: Add icon column to support_channels table for server-driven UI rendering
ALTER TABLE support_channels ADD COLUMN IF NOT EXISTS icon VARCHAR(100);

UPDATE support_channels SET icon = 'ticket' WHERE id = 'ticket' AND icon IS NULL;
UPDATE support_channels SET icon = 'message-square' WHERE id = 'discord' AND icon IS NULL;
UPDATE support_channels SET icon = 'send' WHERE id = 'telegram' AND icon IS NULL;
