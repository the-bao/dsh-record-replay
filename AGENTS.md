# AGENTS.md

`dsh-record-replay` is a DeepSeek Harness plugin. The recorder and
replayer implement the structural `LlmAdapter` shape; the CLI serves
the offline workflow. Tests are structural; the build emits ESM
through esbuild.

## Commands

```sh
npm install --legacy-peer-deps   # peer dep resolution differs across dsh-llm versions
npm run typecheck                # tsc --noEmit on src + tests
npm test                          # vitest run, 40 tests
npm run build                     # esbuild → lib/*.js (ESM, target node20)
node lib/cli.js --help            # exercise the CLI
```

## Layout

```
src/             Implementation
  types.ts       Stable type exports; structural `LlmAdapterLike` interface.
  fixture.ts     JSONL writer (fsync per record) + reader + fingerprint + extractExtras.
  recorder.ts    RecorderAdapter: mirrors inner stream() calls to a fixture.
  replayer.ts    ReplayerAdapter: serves a fixture through a strategy cursor.
  strategies.ts  Sequential, Exact, Fuzzy matching strategies.
  redact.ts      Path-based redactor with shape + length + optional hash.
  diff.ts        Structural diff between two fixtures.
  merge.ts       Concatenate two fixtures into a third.
  cli.ts         `dsh-rec` command-line interface.
  invariant.ts   Assertion helpers; surface-tagged failure messages.
  index.ts       Public re-exports.
tests/           Vitest unit tests (40 total).
scripts/         Build script (esbuild CLI).
examples/        Sample fixture generator.
examples/sample-fixture.jsonl
                 Hand-built example fixture (regenerate via
                 `node examples/generate-fixture.mjs`).
```

## Conventions

- ESM only, Node 20+ target.
- `import './foo.ts'` is allowed under `moduleResolution: bundler`; the
  build strips the extension through esbuild's bundling step.
- Type-only imports from `@deepseek-ai/dsh-llm` are erased at runtime;
  the package does not depend on the dsh-llm value exports.
- Recorder/Replayer are structural: they implement `stream(options)` and
  accept any value with that method as a peer. The dsh `LlmAdapter`
  abstract class is not extended.
- Fixtures are append-only and fsynced per record; never `writeFile`
  the whole fixture, never buffer in memory beyond a single call's chunks.
- The CLI parses positional args first, then `--flag value`; `=` form is
  also accepted.

## Testing policy

- 100% line / branch coverage on `src/` is the gate, enforced in CI by
  `vitest --coverage`. Excluded from coverage: `cli.ts` (CLI shell) and
  `invariant.ts` (assertion glue).
- The test suite is structural; live dsh integration tests are out of
  scope and would require a real LLM key.
- Tests describe behavior, not correctness: change obsolete behavior
  with its tests; explain why in the PR.

## Adding a new feature

1. Add a fixture-record field, matcher, redact path, or CLI subcommand.
2. Cover it in `tests/<module>.spec.ts`. Keep `noUnusedLocals` honest.
3. Run `npm run typecheck && npm test` before pushing.
4. Update `README.md` (English first; 中文 below).

## License

MIT.
