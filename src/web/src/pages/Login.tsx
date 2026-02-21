/**
 * Login page.
 *
 * Simple form that authenticates via POST /api/v1/auth/login.
 * On success, stores JWT in React auth context and navigates to calendar.
 *
 * Converted from inline styles to Tailwind CSS while preserving
 * the same DOM structure, labels, and form behavior so existing tests pass.
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
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-[400px] rounded-lg bg-card p-8 shadow-md">
        <h1 className="mb-1 text-[1.75rem] font-bold text-foreground">
          T-Minus
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Calendar Federation Engine
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="email"
              className="text-sm font-medium text-slate-300"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="rounded-md border border-border bg-background px-3 py-2.5 text-sm text-slate-200 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="password"
              className="text-sm font-medium text-slate-300"
            >
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
              className="rounded-md border border-border bg-background px-3 py-2.5 text-sm text-slate-200 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter password"
            />
          </div>

          {error && <p className="m-0 text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 cursor-pointer rounded-md border-none bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
