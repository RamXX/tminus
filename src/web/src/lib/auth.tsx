/**
 * Authentication context for the T-Minus SPA.
 *
 * JWT is stored in React state/context and mirrored into sessionStorage.
 * sessionStorage keeps auth across same-tab reloads (needed for OAuth redirect
 * round-trips) while avoiding long-lived localStorage persistence.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

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

  const login = useCallback(
    (token: string, refreshToken: string, user: { id: string; email: string }) => {
      const nextState: AuthState = { token, refreshToken, user };
      setState(nextState);
      writeAuthState(nextState);
    },
    [],
  );

  const logout = useCallback(() => {
    setState(EMPTY_AUTH_STATE);
    writeAuthState(EMPTY_AUTH_STATE);
    window.location.hash = "#/login";
  }, []);

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
