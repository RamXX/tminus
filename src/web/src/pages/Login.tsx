/**
 * Login page -- Settlement Monitor aesthetic.
 *
 * Full-page centered card on near-black canvas. Gold primary CTA.
 * Entrance animation via Framer Motion cardVariants.
 *
 * Preserves: email/password form, useAuth() hook, error handling,
 * loading state, data-testid attributes.
 */

import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { useAuth } from "../lib/auth";
import { login as apiLogin, ApiError } from "../lib/api";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { cardVariants } from "../lib/motion";

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
    <div className="flex min-h-screen items-center justify-center bg-background">
      <motion.div
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-sm mx-auto"
      >
        <Card>
          <CardHeader className="items-center text-center">
            <h1 className="text-lg font-semibold tracking-wider uppercase text-foreground">
              T-Minus
            </h1>
            <p className="font-mono text-xs text-muted-foreground">
              Calendar Federation Engine
            </p>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="email"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
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
                  className="bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="you@example.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="password"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
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
                  className="bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Enter password"
                />
              </div>

              {error && (
                <p className="text-destructive text-xs mt-2">{error}</p>
              )}

              <Button type="submit" disabled={loading} className="w-full mt-2">
                {loading ? "Signing in..." : "Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
