-- Migration 0016: Organization members table.
--
-- Maps users to organizations with role-based access (admin/member).
-- Admins can manage members; members have read-only org access.

CREATE TABLE org_members (
  org_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL CHECK(role IN ('admin','member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(org_id, user_id)
);
