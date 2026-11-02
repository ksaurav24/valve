# HTTP clients

Source: [HTTP clients](https://valvejs.vercel.app/docs/examples/http-clients/)
and [Respect provider feedback](https://valvejs.vercel.app/docs/guides/respect-retry-after/).

valve needs to see responses to read rate-limit headers. How it sees them
depends on the client.

## fetch

```ts
const partnerFetch = partner.wrapFetch();
const res = await partnerFetch('https://api.partner.example/v2/orders', {
  headers: { authorization: `Bearer ${token}` },
});
```

Per-request cost or priority from the arguments:

```ts
const partnerFetch = partner.wrapFetch(fetch, {
  cost: (input) => (String(input).includes('/search') ? 5 : 1),
  priority: (_input, init) => (init?.method === 'GET' ? 1 : 0),
});
```

Side-effecting calls the provider guarantees idempotent (verify first):

```ts
const createOrderFetch = partner.wrapFetch(fetch, {
  retryUnsafeMethods: true,
});
await createOrderFetch(url, {
  method: 'POST',
  headers: { 'Idempotency-Key': operationId },
  body: JSON.stringify(order),
});
```

An `Idempotency-Key` header alone does not enable retries. Keep the opt-in on a
dedicated wrapper so other POSTs are not replayed.

## undici

```ts
import { fetch as undiciFetch } from 'undici';
const partnerFetch = partner.wrapFetch(undiciFetch, { retries: 3 });
```

## axios

axios rejects non-2xx, so the `observe` run option never sees a 429. Observe
the error response too:

```ts
import axios, { isAxiosError, type AxiosResponse } from 'axios';
import type { ResponseLike } from 'valvejs';

const fromAxios = (res: AxiosResponse): ResponseLike => ({
  status: res.status,
  headers: res.headers as Record<string, string>,
});

export function partnerGet<T>(url: string) {
  return partner.run(async ({ signal }) => {
    try {
      const res = await axios.get<T>(url, { signal });
      partner.observe(fromAxios(res));
      return res.data;
    } catch (error) {
      if (isAxiosError(error) && error.response)
        partner.observe(fromAxios(error.response));
      throw error;
    }
  });
}
```

valve does not retry here; a 429 rejects after setting the shared pause. Retry
at the caller (or job queue) if needed.

## got

```ts
import got from 'got';

const res = await partner.run(
  ({ signal }) =>
    got(url, { signal, throwHttpErrors: false, retry: { limit: 0 } }),
  { observe: (r) => ({ status: r.statusCode, headers: r.headers }) },
);
```

Disable client-level automatic retries when each attempt must spend quota.
Otherwise got or an SDK can issue several requests inside one admitted job.
Retry outside `run`, or use `wrapFetch` for its supported response retries.

## SDK methods

```ts
const getOrder = partner.wrap((id: string) => sdk.orders.get(id), {
  priority: 1,
});
const order = await getOrder('ord_123');
```

`wrap` does not see HTTP responses. If the SDK exposes status and headers (on
results or on errors), call `partner.observe({ status, headers })` inside the
wrapped function. If the SDK retries 429s itself, consider disabling that so
retries go through the valve.

## Custom headers

`defaultFeedback` reads `Retry-After` (429/503), IETF `RateLimit`/
`RateLimit-Remaining`/`RateLimit-Reset`, and `x-ratelimit-*`/`x-rate-limit-*`.
A response with zero remaining quota pauses even on 200. For other header
names:

```ts
import { combine, defaultFeedback, xRateLimit } from 'valvejs/headers';

createValve({
  id: 'partner',
  rate,
  feedback: combine(
    defaultFeedback,
    xRateLimit({
      remaining: 'x-app-calls-left',
      reset: 'x-app-reset-ms',
      resetUnit: 'ms',
    }),
  ),
});
```

`resetUnit`: `'auto'` (default), `'seconds'`, `'epoch-seconds'`, `'epoch-ms'`,
`'ms'`, `'duration'`. A custom reader is `(response) => ({ pauseMs?, remaining?, resetMs? }) | undefined`;
it must be pure, fast, and must not read the body.
