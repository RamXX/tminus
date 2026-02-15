-- Migration 0003: Add auth fields to users table.
-- Supports user registration and login with password-based auth.
-- password_hash stores PBKDF2 derived key in "<hex-salt>:<hex-key>" format.
-- password_version enables session invalidation on password change.
-- failed_login_attempts + locked_until support progressive account lockout.

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
