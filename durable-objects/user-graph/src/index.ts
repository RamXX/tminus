import { APP_NAME } from "@tminus/shared";

/**
 * UserGraphDO -- per-user Durable Object storing the canonical event graph.
 * This is the primary data store per AD-1 (DO SQLite is primary per-user store).
 */
export class UserGraphDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return new Response(`${APP_NAME} UserGraphDO`, { status: 200 });
  }
}
