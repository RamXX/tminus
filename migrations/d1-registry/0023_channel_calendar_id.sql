-- Migration 0023: Add per-scope calendar routing column.
--
-- The channel_calendar_id column stores the provider-specific calendar ID
-- associated with the watch channel / MS subscription. This enables per-scope
-- webhook routing so the sync-consumer knows which calendar was modified
-- without needing to sync all calendars.
--
-- For Google: set during watch channel registration in OnboardingWorkflow.
-- For Microsoft: set when the subscription is created (or NULL for legacy
--   subscriptions that predate per-scope routing).
--
-- NULL means "legacy channel -- sync all scopes" (graceful fallback).

ALTER TABLE accounts ADD COLUMN channel_calendar_id TEXT DEFAULT NULL;
