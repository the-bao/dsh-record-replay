/**
 * Redact a fixture: replace configurable secret-shaped fields with stable
 * placeholders. Redaction preserves shape and length but never the value,
 * so a diff against the original always reveals a redacted field with a
 * {@link RedactedField} in its place. Stable hashes let a developer
 * confirm "two redacted fields are the same secret" without ever seeing
 * the secret itself.
 *
 * @module @dsh-contrib/dsh-record-replay/redact
 */

import { createHash } from 'node:crypto'
import type { RedactedField, RedactedFixtureRecord } from './types.ts'

/** Default paths the redactor scans. */
const DEFAULT_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['extras', 'apiKey'],
  ['extras', 'api_key'],
  ['extras', 'apiKeyEnv'],
  ['extras', 'headers'],
  ['extras', 'Authorization'],
  ['extras', 'authorization'],
  ['extras', 'system'],
  ['chunks', 'reasoning'],
]

/** Options for {@link redactFixture}. */
export interface RedactOptions {
  /** Paths to redact, written as string segments. Defaults cover the common secret shapes. */
  readonly paths?: ReadonlyArray<ReadonlyArray<string>>
  /**
   * When `true`, replace string values with `<redacted:N>` where N is the
   * UTF-16 length. When `false`, replace with the string `'<redacted>'`.
   * Defaults to `true` so length-based assertions still pass.
   */
  readonly preserveLength?: boolean
  /**
   * When `true`, every redacted field gets a stable SHA-256 hash. Two
   * redacted fields with the same hash come from the same original value.
   * Defaults to `false` to keep fixtures compact.
   */
  readonly withHash?: boolean
}

/** Outcome of a redaction. */
export interface RedactionReport {
  /** Number of fields redacted. */
  readonly count: number
  /** Distinct paths redacted, in the order they were discovered. */
  readonly paths: ReadonlyArray<string>
}

/**
 * Redact one fixture record in place. The returned record is a deep copy
 * with the configured paths replaced by `RedactedField` placeholders. A
 * report lists the paths that were redacted.
 */
export function redactRecord(
  record: import('./types.ts').FixtureRecord | import('./fixture.ts').FixtureFailure,
  options: RedactOptions = {},
): { record: RedactedFixtureRecord; report: RedactionReport } {
  const paths = options.paths ?? DEFAULT_PATHS
  const preserveLength = options.preserveLength ?? true
  const withHash = options.withHash ?? false
  const redactedPaths = new Set<string>()
  let count = 0
  const recordRecord = record as unknown as Record<string, unknown>
  const next: Record<string, unknown> = { ...recordRecord }
  for (const path of paths) {
    if (redactPath(next, path, preserveLength, withHash)) {
      redactedPaths.add(path.join('.'))
      count += 1
    }
  }
  return {
    record: next as unknown as RedactedFixtureRecord,
    report: { count, paths: [...redactedPaths] },
  }
}

/** Redact multiple records; the report is summed across the run. */
export function redactRecords(
  records: ReadonlyArray<import('./types.ts').FixtureRecord | import('./fixture.ts').FixtureFailure>,
  options: RedactOptions = {},
): { records: ReadonlyArray<RedactedFixtureRecord>; report: RedactionReport } {
  const out: RedactedFixtureRecord[] = []
  let totalCount = 0
  const allPaths = new Set<string>()
  for (const record of records) {
    const { record: next, report } = redactRecord(record, options)
    out.push(next)
    totalCount += report.count
    for (const p of report.paths) allPaths.add(p)
  }
  return { records: out, report: { count: totalCount, paths: [...allPaths] } }
}

/** Recursively walk `value` and redact the leaf at `path`. */
function redactPath(
  value: Record<string, unknown>,
  path: ReadonlyArray<string>,
  preserveLength: boolean,
  withHash: boolean,
): boolean {
  if (path.length === 0) return false
  const [head, ...rest] = path as [string, ...string[]]
  if (rest.length === 0) {
    const existing = value[head]
    if (existing === undefined) return false
    if (typeof existing === 'string') {
      value[head] = placeholder(existing, 'string', preserveLength, withHash)
      return true
    }
    if (typeof existing === 'number') {
      value[head] = placeholder(String(existing), 'number', preserveLength, withHash)
      return true
    }
    if (typeof existing === 'boolean') {
      value[head] = placeholder(String(existing), 'boolean', preserveLength, withHash)
      return true
    }
    if (Array.isArray(existing)) {
      value[head] = placeholder('<array>', 'array', preserveLength, withHash)
      return true
    }
    if (existing !== null && typeof existing === 'object') {
      value[head] = placeholder('<object>', 'object', preserveLength, withHash)
      return true
    }
    return false
  }
  const next = value[head]
  if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) return false
  return redactPath(next as Record<string, unknown>, rest, preserveLength, withHash)
}

function placeholder(value: string, shape: RedactedField['shape'], preserveLength: boolean, withHash: boolean): RedactedField {
  const length = preserveLength ? Array.from(value).length : undefined
  const hash = withHash ? createHash('sha256').update(value).digest('hex').slice(0, 12) : undefined
  const out: RedactedField = { redacted: true, shape }
  if (length !== undefined) (out as { length?: number }).length = length
  if (hash !== undefined) (out as { hash?: string }).hash = hash
  return out
}
