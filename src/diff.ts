/**
 * Compare two fixtures and produce a per-call diff. The diff lists calls
 * present in only one fixture, calls whose request fingerprint differs, and
 * calls whose chunk sequence differs. The CLI prints the diff in a stable
 * text format suitable for review or as a CI assertion.
 *
 * @module @dsh-contrib/dsh-record-replay/diff
 */

import type { LoadedCall, LoadedFixture } from './fixture.ts'
import type { RequestFingerprint, StreamChunk } from './types.ts'

/** A single diff entry. */
export type DiffEntry =
  | { kind: 'missing-in-right'; callId: string; fingerprint: RequestFingerprint }
  | { kind: 'missing-in-left'; callId: string; fingerprint: RequestFingerprint }
  | { kind: 'fingerprint-changed'; callId: string; left: RequestFingerprint; right: RequestFingerprint }
  | { kind: 'outcome-changed'; callId: string; left: 'chunks' | 'failure'; right: 'chunks' | 'failure' }
  | { kind: 'chunks-differ'; callId: string; firstDiff: number; left: StreamChunk; right: StreamChunk }

/** Top-level diff result. */
export interface DiffResult {
  /** One diff entry per discovered difference. */
  readonly entries: ReadonlyArray<DiffEntry>
  /** True when the two fixtures are equivalent under the diff rules. */
  readonly equivalent: boolean
}

/**
 * Compare two fixtures call-by-call. The diff is structural: it does not
 * replay either side. The two fixtures are paired by call order (call N of
 * the left fixture is compared to call N of the right fixture); a different
 * number of calls surfaces as `missing-in-right` / `missing-in-left`.
 */
export function diffFixtures(left: LoadedFixture, right: LoadedFixture): DiffResult {
  const entries: DiffEntry[] = []
  const max = Math.max(left.calls.length, right.calls.length)
  for (let i = 0; i < max; i++) {
    const l = left.calls[i]
    const r = right.calls[i]
    if (l === undefined) {
      entries.push({ kind: 'missing-in-left', callId: r!.request.callId, fingerprint: r!.request.fingerprint })
      continue
    }
    if (r === undefined) {
      entries.push({ kind: 'missing-in-right', callId: l.request.callId, fingerprint: l.request.fingerprint })
      continue
    }
    compareCall(l, r, entries)
  }
  return { entries, equivalent: entries.length === 0 }
}

function compareCall(left: LoadedCall, right: LoadedCall, out: DiffEntry[]): void {
  if (left.request.fingerprint !== right.request.fingerprint) {
    out.push({
      kind: 'fingerprint-changed',
      callId: left.request.callId,
      left: left.request.fingerprint,
      right: right.request.fingerprint,
    })
    return
  }
  if (left.outcome !== right.outcome) {
    out.push({
      kind: 'outcome-changed',
      callId: left.request.callId,
      left: left.outcome,
      right: right.outcome,
    })
    return
  }
  if (left.outcome === 'chunks' && right.outcome === 'chunks') {
    const leftChunks = left.chunks.chunks
    const rightChunks = right.chunks.chunks
    const min = Math.min(leftChunks.length, rightChunks.length)
    for (let i = 0; i < min; i++) {
      if (!chunkEquals(leftChunks[i] as StreamChunk, rightChunks[i] as StreamChunk)) {
        out.push({
          kind: 'chunks-differ',
          callId: left.request.callId,
          firstDiff: i,
          left: leftChunks[i] as StreamChunk,
          right: rightChunks[i] as StreamChunk,
        })
        return
      }
    }
    if (leftChunks.length !== rightChunks.length) {
      out.push({
        kind: 'chunks-differ',
        callId: left.request.callId,
        firstDiff: min,
        left: { type: 'finish', reason: { kind: 'stop' } },
        right: { type: 'finish', reason: { kind: 'stop' } },
      })
    }
    return
  }
  if (left.outcome === 'failure' && right.outcome === 'failure') {
    if (left.failure.failure.code !== right.failure.failure.code) {
      out.push({
        kind: 'outcome-changed',
        callId: left.request.callId,
        left: 'failure',
        right: 'failure',
      })
    }
  }
}

/** Structural equality for two `StreamChunk` values. */
function chunkEquals(a: StreamChunk, b: StreamChunk): boolean {
  if (a.type !== b.type) return false
  // `JSON.stringify` on the discriminant-tagged union is stable for
  // structural comparison; the chunk union has no `undefined`-only
  // fields, so the round-trip is loss-free.
  return JSON.stringify(a) === JSON.stringify(b)
}
