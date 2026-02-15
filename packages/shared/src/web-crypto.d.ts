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

/** Opaque handle returned by crypto.subtle.importKey. */
declare interface CryptoKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: object;
  readonly usages: string[];
}

declare const crypto: {
  subtle: {
    digest(
      algorithm: string,
      data: BufferSource,
    ): Promise<ArrayBuffer>;

    importKey(
      format: string,
      keyData: BufferSource,
      algorithm: string | { name: string; hash?: string },
      extractable: boolean,
      keyUsages: string[],
    ): Promise<CryptoKey>;

    sign(
      algorithm: string | { name: string },
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer>;

    verify(
      algorithm: string | { name: string },
      key: CryptoKey,
      signature: BufferSource,
      data: BufferSource,
    ): Promise<boolean>;

    deriveBits(
      algorithm: {
        name: string;
        salt: BufferSource;
        iterations: number;
        hash: string;
      },
      baseKey: CryptoKey,
      length: number,
    ): Promise<ArrayBuffer>;
  };

  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

declare function btoa(data: string): string;
declare function atob(data: string): string;
