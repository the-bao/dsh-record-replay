import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/recorder.ts', 'src/replayer.ts', 'src/fixture.ts', 'src/redact.ts', 'src/strategies.ts', 'src/invariant.ts', 'src/diff.ts', 'src/merge.ts'],
  format: ['esm'],
  outDir: 'lib',
  clean: false,
  dts: false,
  target: 'node20',
  platform: 'node',
  external: ['@deepseek-ai/dsh-llm', 'node:*'],
})
