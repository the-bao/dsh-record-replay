import { build } from 'esbuild'

const entries = ['index', 'cli', 'recorder', 'replayer', 'fixture', 'redact', 'strategies', 'invariant', 'diff', 'merge']

await build({
  entryPoints: entries.map((e) => `src/${e}.ts`),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outdir: 'lib',
  outExtension: { '.js': '.js' },
  external: ['@deepseek-ai/dsh-llm'],
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})
console.log('build ok')
