/**
 * Authentication context for the T-Minus SPA.
 *
 * JWT is stored in React state/context ONLY (NOT localStorage) for security.
 * This means tokens are lost on page refresh, which is intentional for a
 * walking skeleton. A future story will add refresh token persistence.
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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    token: null,
    refreshToken: null,
    user: null,
  });

  const login = useCallback(
    (token: string, refreshToken: string, user: { id: string; email: string }) => {
      setState({ token, refreshToken, user });
    },
    [],
  );

  const logout = useCallback(() => {
    setState({ token: null, refreshToken: null, user: null });
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
