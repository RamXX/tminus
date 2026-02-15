-- Migration 0007: Add deletion_summary column to deletion_certificates.
-- Stores a JSON summary of what was deleted (event counts, mirror counts, etc.)
-- No PII -- only aggregate counts.
ALTER TABLE deletion_certificates ADD COLUMN deletion_summary TEXT;
