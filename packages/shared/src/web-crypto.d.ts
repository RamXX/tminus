/**
 * Minimal ambient type declarations for Web Crypto API and TextEncoder.
 *
 * These are standardized Web APIs available in both Cloudflare Workers
 * and Node.js >= 18. The shared package uses `types: []` in tsconfig
 * to avoid pulling in environment-specific types, so we declare just
 * the subset we need.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const crypto: {
  subtle: {
    digest(
      algorithm: string,
      data: BufferSource,
    ): Promise<ArrayBuffer>;
  };
};
