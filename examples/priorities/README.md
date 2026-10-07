# Priorities example

UC4: interactive work starts before background sync in a local queue.

Run `pnpm build` at the repository root first, then:

```sh
pnpm --filter @valve/example-priorities start
```

The example uses deterministic local work, rather than provider credentials.
No external service is required.
