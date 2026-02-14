import { APP_NAME } from "@tminus/shared";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(`${APP_NAME} API worker`, { status: 200 });
  },
};
