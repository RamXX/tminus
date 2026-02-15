-- Migration 0017: Organization-level policies
--
-- Stores org-level policies that apply to all members.
-- Policy types:
--   mandatory_working_hours: minimum working hours window
--   minimum_vip_priority: minimum priority weight for VIPs
--   required_projection_detail: minimum projection detail level
--   max_account_count: maximum linked accounts per member
--
-- Org policies act as a floor: users can be stricter but not more lenient.

CREATE TABLE org_policies (
  policy_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  policy_type TEXT NOT NULL CHECK(policy_type IN (
    'mandatory_working_hours',
    'minimum_vip_priority',
    'required_projection_detail',
    'max_account_count'
  )),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT NOT NULL
);

CREATE INDEX idx_org_policies_org ON org_policies(org_id);
CREATE UNIQUE INDEX idx_org_policies_org_type ON org_policies(org_id, policy_type);
