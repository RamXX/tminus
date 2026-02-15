/**
 * @tminus/shared/auth -- Authentication utilities.
 *
 * Re-exports JWT and password utilities from their respective modules.
 */

export {
  generateJWT,
  verifyJWT,
  generateRefreshToken,
  JWT_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "./jwt";
export type { JWTPayload, SubscriptionTier } from "./jwt";

export { hashPassword, verifyPassword } from "./password";
