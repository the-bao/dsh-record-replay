/**
 * Merge two fixtures into one. The merge is a stable concatenation of the
 * right fixture's calls after the left fixture's calls, with a fresh
 * header that names both source fixtures in `meta`. A use case: a developer
 * records one session per scenario and wants a single fixture that drives
 * a wider regression.
 *
 * @module @dsh-contrib/dsh-record-replay/merge
 */

import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LoadedFixture, FixtureFailure } from './fixture.ts'
import type { FixtureRequest, FixtureChunks, FixtureHeader } from './types.ts'
import { FIXTURE_VERSION } from './types.ts'
import { readFixture } from './fixture.ts'
import { invariant } from './invariant.ts'

/** Options for {@link mergeFixtures}. */
export interface MergeOptions {
  /** Output file path. */
  readonly file: string
  /** Optional override for the merged header's provider route. */
  readonly provider?: string
  /** Optional override for the merged header's model id. */
  readonly model?: string
  /** Optional human-readable label for the merged fixture. */
  readonly label?: string
}

/** Read two fixtures and write their concatenation to a third file. */
export function mergeFixtures(leftFile: string, rightFile: string, options: MergeOptions): { written: string; count: number } {
  invariant(typeof leftFile === 'string' && leftFile.length > 0, 'mergeFixtures', 'left file is required')
  invariant(typeof rightFile === 'string' && rightFile.length > 0, 'mergeFixtures', 'right file is required')
  const left = readFixture(leftFile)
  const right = readFixture(rightFile)
  return writeMerge(left, right, options)
}

/** Merge two in-memory fixtures. */
export function writeMerge(left: LoadedFixture, right: LoadedFixture, options: MergeOptions): { written: string; count: number } {
  mkdirSync(dirname(options.file), { recursive: true })
  const header: FixtureHeader = {
    kind: 'header',
    version: FIXTURE_VERSION,
    recordedAt: new Date().toISOString(),
    provider: options.provider ?? left.header.provider,
    model: options.model ?? left.header.model,
    ...(options.label !== undefined ? { label: options.label } : {}),
    meta: {
      mergedFrom: `${left.header.recordedAt},${right.header.recordedAt}`,
    },
  }
  const fd = openSync(options.file, 'w')
  try {
    writeSync(fd, Buffer.from(JSON.stringify(header) + '\n', 'utf8'))
    let count = 0
    for (const call of [...left.calls, ...right.calls]) {
      const request: FixtureRequest = call.request
      writeSync(fd, Buffer.from(JSON.stringify(request) + '\n', 'utf8'))
      if (call.outcome === 'chunks') {
        const chunks: FixtureChunks = call.chunks
        writeSync(fd, Buffer.from(JSON.stringify(chunks) + '\n', 'utf8'))
      } else {
        const failure: FixtureFailure = call.failure
        writeSync(fd, Buffer.from(JSON.stringify(failure) + '\n', 'utf8'))
      }
      count += 1
    }
    return { written: options.file, count }
  } finally {
    closeSync(fd)
  }
}
