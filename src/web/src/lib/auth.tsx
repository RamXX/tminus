/**
 * Authentication context for the T-Minus SPA.
 *
 * JWT is stored in React state/context and mirrored into sessionStorage.
 * sessionStorage keeps auth across same-tab reloads (needed for OAuth redirect
 * round-trips) while avoiding long-lived localStorage persistence.
 *
 * Token refresh: when a valid JWT is present, a timer automatically refreshes
 * the access token before it expires. The refresh happens at 80% of the token's
 * lifetime (e.g., a 1-hour token refreshes after 48 minutes). On refresh
 * failure, the user is logged out.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { apiFetch } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthState {
  /** JWT access token, or null if not authenticated. */
  token: string | null;
  /** Refresh token for obtaining new access tokens. */
  refreshToken: string | null;
  /** User info from the login response. */
  user: { id: string; email: string } | null;
}

interface AuthContextValue extends AuthState {
  /** Set auth tokens after successful login/register. */
  login: (token: string, refreshToken: string, user: { id: string; email: string }) => void;
  /** Clear auth state (logout). */
  logout: () => void;
}

// ---------------------------------------------------------------------------
// Token refresh configuration
// ---------------------------------------------------------------------------

/**
 * Fraction of token lifetime at which to trigger refresh.
 * 0.8 means refresh at 80% of expiry (e.g., 48 min into a 60-min token).
 */
const TOKEN_REFRESH_THRESHOLD = 0.8;

/**
 * Minimum delay before scheduling a refresh (1 second).
 * Prevents tight loops if token is already near expiry.
 */
const MIN_REFRESH_DELAY_MS = 1000;

/**
 * Fallback token lifetime if we cannot decode the JWT (15 minutes).
 * This is a conservative default.
 */
const FALLBACK_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

interface JwtPayload {
  exp?: number;
  iat?: number;
}

/**
 * Decode a JWT payload without verifying the signature.
 * Returns null if the token is malformed.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // Base64url to base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Calculate the delay in milliseconds before the token should be refreshed.
 * Returns null if the token cannot be decoded or has no expiry.
 */
export function getTokenRefreshDelay(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  const now = Date.now() / 1000;

  if (payload.exp) {
    const lifetime = payload.iat
      ? payload.exp - payload.iat
      : payload.exp - now;
    const refreshAt = payload.iat
      ? payload.iat + lifetime * TOKEN_REFRESH_THRESHOLD
      : now + lifetime * TOKEN_REFRESH_THRESHOLD;
    const delayMs = (refreshAt - now) * 1000;
    return Math.max(delayMs, MIN_REFRESH_DELAY_MS);
  }

  // No exp claim -- use fallback
  return FALLBACK_TOKEN_LIFETIME_MS * TOKEN_REFRESH_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "tminus_auth_v1";
const EMPTY_AUTH_STATE: AuthState = {
  token: null,
  refreshToken: null,
  user: null,
};

function readAuthState(): AuthState {
  try {
    const raw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return EMPTY_AUTH_STATE;
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.refreshToken === "string" &&
      parsed.user &&
      typeof parsed.user.id === "string" &&
      typeof parsed.user.email === "string"
    ) {
      return {
        token: parsed.token,
        refreshToken: parsed.refreshToken,
        user: {
          id: parsed.user.id,
          email: parsed.user.email,
        },
      };
    }
  } catch {
    // If storage is corrupted, ignore and treat as logged out.
  }
  return EMPTY_AUTH_STATE;
}

function writeAuthState(state: AuthState): void {
  try {
    if (!state.token || !state.refreshToken || !state.user) {
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence only.
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => readAuthState());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRefreshingRef = useRef(false);

  const login = useCallback(
    (token: string, refreshToken: string, user: { id: string; email: string }) => {
      const nextState: AuthState = { token, refreshToken, user };
      setState(nextState);
      writeAuthState(nextState);
    },
    [],
  );

  const logout = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setState(EMPTY_AUTH_STATE);
    writeAuthState(EMPTY_AUTH_STATE);
    window.location.hash = "#/login";
  }, []);

  // -------------------------------------------------------------------------
  // Token refresh effect
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Clear any existing timer when token changes
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    const { token, refreshToken, user } = state;
    if (!token || !refreshToken || !user) return;

    const delay = getTokenRefreshDelay(token);
    if (delay === null) return;

    refreshTimerRef.current = setTimeout(async () => {
      // Guard against concurrent refresh attempts
      if (isRefreshingRef.current) return;
      isRefreshingRef.current = true;

      try {
        const result = await apiFetch<{
          access_token: string;
          refresh_token: string;
        }>("/v1/auth/refresh", {
          method: "POST",
          body: { refresh_token: refreshToken },
        });

        const nextState: AuthState = {
          token: result.access_token,
          refreshToken: result.refresh_token,
          user,
        };
        setState(nextState);
        writeAuthState(nextState);
      } catch {
        // Refresh failed -- session is broken, log the user out
        setState(EMPTY_AUTH_STATE);
        writeAuthState(EMPTY_AUTH_STATE);
        window.location.hash = "#/login";
      } finally {
        isRefreshingRef.current = false;
      }
    }, delay);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [state]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
