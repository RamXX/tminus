/**
 * Login page.
 *
 * Simple form that authenticates via POST /api/v1/auth/login.
 * On success, stores JWT in React auth context and navigates to calendar.
 */

import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { login as apiLogin, ApiError } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await apiLogin(email, password);
      login(result.access_token, result.refresh_token, {
        id: result.user.id,
        email: result.user.email,
      });
      // Navigation happens automatically via the Router in App.tsx
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Network error. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>T-Minus</h1>
        <p style={styles.subtitle}>Calendar Federation Engine</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label htmlFor="email" style={styles.label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              style={styles.input}
              placeholder="you@example.com"
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="password" style={styles.label}>
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              minLength={8}
              style={styles.input}
              placeholder="Enter password"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (walking skeleton -- CSS framework added later)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
  },
  card: {
    background: "#1e293b",
    borderRadius: "8px",
    padding: "2rem",
    width: "100%",
    maxWidth: "400px",
    boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
  },
  title: {
    fontSize: "1.75rem",
    fontWeight: 700,
    marginBottom: "0.25rem",
    color: "#f1f5f9",
  },
  subtitle: {
    fontSize: "0.875rem",
    color: "#94a3b8",
    marginBottom: "1.5rem",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  label: {
    fontSize: "0.875rem",
    fontWeight: 500,
    color: "#cbd5e1",
  },
  input: {
    padding: "0.625rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    outline: "none",
  },
  error: {
    color: "#f87171",
    fontSize: "0.875rem",
    margin: 0,
  },
  button: {
    padding: "0.625rem",
    borderRadius: "6px",
    border: "none",
    background: "#3b82f6",
    color: "#ffffff",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "0.5rem",
  },
};
