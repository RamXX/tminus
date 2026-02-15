-- Migration 0022: Domain-wide delegation for Workspace orgs.
--
-- Stores domain-wide delegation configuration per Workspace domain.
-- The service account credentials are stored encrypted (AES-256-GCM per AD-2)
-- in the encrypted_sa_key column as a JSON envelope
-- {iv, ciphertext, encryptedDek, dekIv}.
--
-- delegation_status tracks whether delegation has been validated:
--   'pending'   - Admin registered but delegation not yet validated
--   'active'    - Delegation validated and working
--   'revoked'   - Delegation was revoked or validation failed
--
-- admin_email is the Workspace admin who registered the delegation.

CREATE TABLE org_delegations (
  delegation_id       TEXT PRIMARY KEY,
  domain              TEXT NOT NULL UNIQUE,
  admin_email         TEXT NOT NULL,
  delegation_status   TEXT NOT NULL DEFAULT 'pending' CHECK(delegation_status IN ('pending', 'active', 'revoked')),
  encrypted_sa_key    TEXT NOT NULL,
  sa_client_email     TEXT NOT NULL,
  sa_client_id        TEXT NOT NULL,
  validated_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_org_delegations_domain ON org_delegations(domain);
CREATE INDEX idx_org_delegations_status ON org_delegations(delegation_status);
