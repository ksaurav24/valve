# Shutdown example

UC5: stop accepting work, reject queued calls, and drain a running call.

Run `pnpm build` at the repository root first, then:

```sh
pnpm --filter @valve/example-shutdown start
```

The example uses deterministic local work, rather than provider credentials.
No external service is required.
