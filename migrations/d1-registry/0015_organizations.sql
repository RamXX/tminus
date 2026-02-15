-- Migration 0015: Multi-tenant organizations table.
--
-- Organizations provide multi-tenant grouping for enterprise users.
-- Each organization has a settings_json column for tenant-specific config.

CREATE TABLE organizations (
  org_id       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT DEFAULT '{}'
);
