import { APP_NAME } from "@tminus/shared";

/**
 * AccountDO -- per-account Durable Object for token refresh, sync cursor, rate limiting.
 * Mandatory per AD-2.
 */
export class AccountDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return new Response(`${APP_NAME} AccountDO`, { status: 200 });
  }
}
