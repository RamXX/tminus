import { APP_NAME } from "@tminus/shared";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(`${APP_NAME} Webhook worker`, { status: 200 });
  },
};
