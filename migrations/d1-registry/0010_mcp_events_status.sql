-- Add status column to mcp_events table for availability computation.
-- Supports 'confirmed', 'tentative', 'cancelled' to match Google Calendar API statuses.
-- Default is 'confirmed' for backward compatibility with existing events.
ALTER TABLE mcp_events ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
