/**
 * Minimal ambient type declarations for the Fetch API.
 *
 * These are standardized Web APIs available in both Cloudflare Workers
 * and Node.js >= 18. The shared package uses `types: []` in tsconfig
 * to avoid pulling in environment-specific types, so we declare just
 * the subset we need for the Google Calendar API client.
 */

declare class URL {
  constructor(url: string | URL, base?: string | URL);
  toString(): string;
  href: string;
}

declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | string[][] | URLSearchParams);
  set(name: string, value: string): void;
  get(name: string): string | null;
  toString(): string;
}

declare class Headers {
  constructor(init?: HeadersInit);
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  delete(name: string): void;
}

type HeadersInit = Headers | Record<string, string> | [string, string][];

interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | ArrayBuffer | ReadableStream | null;
  signal?: AbortSignal;
}

declare class Request {
  constructor(input: string | URL | Request, init?: RequestInit);
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

declare class Response {
  constructor(body?: string | ArrayBuffer | ReadableStream | null, init?: ResponseInit);
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface AbortSignal {
  readonly aborted: boolean;
}

declare namespace globalThis {
  function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}
