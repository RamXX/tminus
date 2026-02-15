-- Migration 0008: Add sync-status columns to the accounts table.
-- Enables MCP sync health computation without reaching into AccountDO.
ALTER TABLE accounts ADD COLUMN last_sync_ts TEXT;
ALTER TABLE accounts ADD COLUMN resource_id TEXT;
ALTER TABLE accounts ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
