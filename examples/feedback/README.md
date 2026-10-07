# Feedback example

UC3: a rate limit response pauses another worker on the same Redis budget.

Run `pnpm build` at the repository root first, then:

```sh
REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @valve/example-feedback start
```

The example uses deterministic local work, rather than provider credentials.
A connected Redis or Valkey server is required.
