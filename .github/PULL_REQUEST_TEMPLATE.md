### What this changes

<!-- A sentence or two on the change. -->

### Type

- [ ] New benchmark spec (`benchmarks/<slug>.yml`)
- [ ] New harness (`harnesses/<slug>/`)
- [ ] Site / component changes
- [ ] Docs / tutorial
- [ ] Other

### Checklist

- [ ] `pnpm validate` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] If a new spec: queries dry-run successfully against the Prometheus URL
- [ ] If a new harness: README documents inputs, regions, timeouts, and how to run it locally
- [ ] No API keys, secrets or private endpoints committed
