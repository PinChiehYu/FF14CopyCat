import { handleRequest, type CacheLike, type Context, type Env } from './handler'

// Workers 執行環境提供的全域快取
declare const caches: { default: CacheLike }

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handleRequest(request, env, ctx, caches.default)
  },
}
