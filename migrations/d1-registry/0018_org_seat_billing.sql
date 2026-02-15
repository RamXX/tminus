-- Migration 0018: Add seat billing columns to organizations.
--
-- Extends the organizations table with per-seat billing support:
-- - seat_limit: maximum members allowed (default 5 = enterprise base includes)
-- - stripe_subscription_id: links org to its Stripe subscription for
--   seat quantity management

ALTER TABLE organizations ADD COLUMN seat_limit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
