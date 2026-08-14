#!/usr/bin/env node
/**
 * `dsh-rec` command-line interface.
 *
 * Subcommands:
 *   inspect <fixture>           List every recorded call with its fingerprint, started time, and outcome summary.
 *   diff <a> <b>                Print the structural diff between two fixtures.
 *   redact <fixture> --out F    Write a redacted copy of the fixture.
 *   merge <a> <b> --out F       Concatenate two fixtures into one.
 *   help                        Print the usage summary.
 *
 * The CLI is a thin wrapper over the public API. Recording and replaying are
 * Cordis composition concerns (the recorder and replayer are dsh plugins)
 * and live in user code; the CLI serves the offline tooling side of the
 * workflow.
 *
 * @module @dsh-contrib/dsh-record-replay/cli
 */

import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { readFixture } from './fixture.ts'
import { redactRecord, redactRecords } from './redact.ts'
import { diffFixtures } from './diff.ts'
import { mergeFixtures } from './merge.ts'
import { errorMessage, invariant } from './invariant.ts'

const USAGE = `dsh-rec — record and replay DeepSeek Harness LLM calls.

Usage:
  dsh-rec inspect <fixture>
  dsh-rec diff <a> <b>
  dsh-rec redact <fixture> --out <out-file> [--hash]
  dsh-rec merge <a> <b> --out <out-file> [--label <label>]
  dsh-rec help

Subcommands:
  inspect   List every recorded call: index, fingerprint, started time, outcome.
  diff      Print the structural diff between two fixtures.
  redact    Write a redacted copy of a fixture (stable length + optional hash).
  merge     Concatenate two fixtures into one; the merged header records both sources.
  help      Print this message.

Recording and replaying are Cordis composition concerns; see README for the
recorder and replayer plugins.
`

interface ParsedArgs {
  readonly command: string | null
  readonly positional: ReadonlyArray<string>
  readonly flags: Map<string, string | boolean>
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  let command: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help' || arg === '-h') {
      flags.set('help', true)
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1))
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(arg.slice(2), next)
          i += 1
        } else {
          flags.set(arg.slice(2), true)
        }
      }
      continue
    }
    if (command === null) {
      command = arg
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.flags.has('help') || parsed.command === null || parsed.command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    switch (parsed.command) {
      case 'inspect':
        return runInspect(parsed.positional)
      case 'diff':
        return runDiff(parsed.positional)
      case 'redact':
        return runRedact(parsed.positional, parsed.flags)
      case 'merge':
        return runMerge(parsed.positional, parsed.flags)
      default:
        process.stderr.write(`dsh-rec: unknown command ${JSON.stringify(parsed.command)}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    process.stderr.write(`dsh-rec: ${errorMessage(error)}\n`)
    return 1
  }
}

function runInspect(positional: ReadonlyArray<string>): number {
  const file = positional[0]
  invariant(file !== undefined, 'inspect', 'usage: dsh-rec inspect <fixture>')
  const fixture = readFixture(file)
  process.stdout.write(`# ${fixture.header.provider} / ${fixture.header.model}\n`)
  if (fixture.header.label !== undefined) process.stdout.write(`# label: ${fixture.header.label}\n`)
  process.stdout.write(`# recorded: ${fixture.header.recordedAt}\n`)
  process.stdout.write(`# calls: ${fixture.calls.length}\n\n`)
  for (let i = 0; i < fixture.calls.length; i++) {
    const call = fixture.calls[i] as (typeof fixture.calls)[number]
    const outcome = call.outcome === 'chunks' ? `${call.chunks.chunks.length} chunks` : `failure (${call.failure.failure.code})`
    process.stdout.write(
      `[${String(i).padStart(4, ' ')}] ${call.request.startedAt}  fingerprint=${call.request.fingerprint}  ${outcome}\n`,
    )
  }
  return 0
}

function runDiff(positional: ReadonlyArray<string>): number {
  const leftFile = positional[0]
  const rightFile = positional[1]
  invariant(leftFile !== undefined && rightFile !== undefined, 'diff', 'usage: dsh-rec diff <a> <b>')
  const left = readFixture(leftFile)
  const right = readFixture(rightFile)
  const result = diffFixtures(left, right)
  if (result.equivalent) {
    process.stdout.write('fixtures are equivalent\n')
    return 0
  }
  for (const entry of result.entries) {
    process.stdout.write(`- ${formatEntry(entry)}\n`)
  }
  return result.equivalent ? 0 : 1
}

function formatEntry(entry: import('./diff.ts').DiffEntry): string {
  switch (entry.kind) {
    case 'missing-in-right':
      return `missing in right: callId=${entry.callId} fingerprint=${entry.fingerprint}`
    case 'missing-in-left':
      return `missing in left: callId=${entry.callId} fingerprint=${entry.fingerprint}`
    case 'fingerprint-changed':
      return `fingerprint changed at callId=${entry.callId}: left=${entry.left} right=${entry.right}`
    case 'outcome-changed':
      return `outcome changed at callId=${entry.callId}: left=${entry.left} right=${entry.right}`
    case 'chunks-differ':
      return `chunks differ at callId=${entry.callId} index=${entry.firstDiff}: left=${JSON.stringify(entry.left)} right=${JSON.stringify(entry.right)}`
  }
}

function runRedact(positional: ReadonlyArray<string>, flags: Map<string, string | boolean>): number {
  const file = positional[0]
  const out = flagString(flags, 'out')
  invariant(file !== undefined && out !== undefined, 'redact', 'usage: dsh-rec redact <fixture> --out <out-file>')
  const fixture = readFixture(file)
  const allRecords: Array<import('./types.ts').FixtureRecord | import('./fixture.ts').FixtureFailure> = [
    fixture.header,
    ...fixture.calls.map((c) => c.request),
    ...fixture.calls.map((c) => (c.outcome === 'chunks' ? c.chunks : c.failure)),
  ]
  const { records, report } = redactRecords(allRecords, {
    withHash: flags.has('hash'),
  })
  const fs = { mkdirSync, openSync, writeSync, closeSync } as const
  fs.mkdirSync(dirname(out), { recursive: true })
  const fd = fs.openSync(out, 'w')
  try {
    for (const record of records) {
      fs.writeSync(fd, JSON.stringify(record) + '\n')
    }
  } finally {
    fs.closeSync(fd)
  }
  process.stdout.write(`redacted ${report.count} field(s) across ${records.length} record(s); wrote ${out}\n`)
  if (report.paths.length > 0) process.stdout.write(`paths: ${report.paths.join(', ')}\n`)
  return 0
}

function runMerge(positional: ReadonlyArray<string>, flags: Map<string, string | boolean>): number {
  const left = positional[0]
  const right = positional[1]
  const out = flagString(flags, 'out')
  invariant(left !== undefined && right !== undefined && out !== undefined, 'merge', 'usage: dsh-rec merge <a> <b> --out <out-file>')
  const label = flagString(flags, 'label')
  const { written, count } = mergeFixtures(left, right, {
    file: out,
    ...(label !== undefined ? { label } : {}),
  })
  process.stdout.write(`merged ${count} call(s) into ${written}\n`)
  return 0
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name)
  return typeof v === 'string' ? v : undefined
}

// `redactRecord` is exported but not used at the CLI level; it is the building
// block for the public API. Keep the import live so a future CLI subcommand
// can use it without an import-order churn.
void redactRecord

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`dsh-rec: ${errorMessage(error)}\n`)
    process.exit(1)
  },
)
