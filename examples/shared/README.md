# Shared example

UC1: six worker instances share one Redis quota.

Run `pnpm build` at the repository root first, then:

```sh
REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @valve/example-shared start
```

The example uses deterministic local work, rather than provider credentials.
A connected Redis or Valkey server is required.
