import {
  http,
  createTransport,
  type Transport,
  type EIP1193RequestFn,
} from "viem";

const starts = new Map<string, number>();
/** Public RPCs enforce a request budget even when calls arrive in JSON batches. */
export function rateLimitedHttp(endpoint: string): Transport {
  return (options) => {
    const base = http(endpoint, { timeout: 15000, retryCount: 0 })(options);
    return createTransport({
      key: "strata-paced-http",
      name: "Strata RPC",
      type: "http",
      retryCount: 0,
      request: (async (args: any) => {
        for (let attempt = 0; ; attempt++) {
          const now = Date.now(),
            start = Math.max(now, starts.get(endpoint) ?? 0);
          starts.set(endpoint, start + 150);
          if (start > now)
            await new Promise((resolve) => setTimeout(resolve, start - now));
          try {
            return await base.request(args as any);
          } catch (error) {
            if (
              attempt >= 3 ||
              !/429|limited|rate limit|timeout|HTTP request failed/i.test(
                error instanceof Error ? error.message : String(error),
              )
            )
              throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, (attempt + 1) * 1000),
            );
          }
        }
      }) as EIP1193RequestFn,
    });
  };
}
