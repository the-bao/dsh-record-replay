/**
 * Strategies that map a live request to a recorded call. The replayer asks
 * the strategy to advance its cursor over a fixture's calls and return the
 * next match for the current request. Strategies are stateless across
 * streams: each call into {@link ReplayerStrategy.nextMatch} sees a
 * monotonically increasing call index, so the strategy is responsible for
 * the call-vs-call ordering but never for the streaming lifecycle.
 *
 * @module @dsh-contrib/dsh-record-replay/strategies
 */

import type { GenerateOptions, MatchStrategy, Message, RequestFingerprint } from './types.ts'
import { fingerprintRequest } from './fixture.ts'
import type { LoadedCall } from './fixture.ts'
import { invariant } from './invariant.ts'

/** Compact view of a request, used for matching without carrying messages through strategies. */
export interface RequestShape {
  provider: string
  model: string
  messages: ReadonlyArray<Message>
  extras?: Readonly<Record<string, unknown>>
}

/** Reason a strategy could not find a match. */
export type NoMatchReason = 'exhausted' | 'fingerprint-mismatch'

/** A strategy that maps live requests to recorded calls. */
export interface ReplayerStrategy {
  /** Strategy name (used in error messages and the CLI's `--strategy` flag). */
  readonly name: MatchStrategy
  /**
   * Find the next recorded call to replay for `request`. Returns `null` when
   * no match is available; the replayer then applies `onExhausted`.
   *
   * The strategy is stateful: each call advances its cursor. The same
   * strategy instance is shared across the replayer, never across replayers.
   */
  nextMatch(
    request: RequestShape,
    calls: ReadonlyArray<LoadedCall>,
    cursor: number,
  ): { match: LoadedCall; nextCursor: number; reason: null } | { match: null; nextCursor: number; reason: NoMatchReason }
}

/**
 * Sequential: always returns the call at the cursor and advances. The live
 * request is checked only to fail loud if the strategy is asked for an
 * "exact" mode (it is not — sequential is the no-checking mode).
 */
export class SequentialStrategy implements ReplayerStrategy {
  readonly name: MatchStrategy = 'sequential'

  nextMatch(
    _request: RequestShape,
    calls: ReadonlyArray<LoadedCall>,
    cursor: number,
  ): { match: LoadedCall; nextCursor: number; reason: null } | { match: null; nextCursor: number; reason: NoMatchReason } {
    if (cursor >= calls.length) return { match: null, nextCursor: cursor, reason: 'exhausted' }
    return { match: calls[cursor] as LoadedCall, nextCursor: cursor + 1, reason: null }
  }
}

/**
 * Exact: match by request fingerprint, scanning forward from the cursor. A
 * live request that has no recorded fingerprint at or after the cursor
 * returns `fingerprint-mismatch`; a cursor that has run past the end of the
 * fixture returns `exhausted`. The first matching call is consumed.
 */
export class ExactStrategy implements ReplayerStrategy {
  readonly name: MatchStrategy = 'exact'

  nextMatch(
    request: RequestShape,
    calls: ReadonlyArray<LoadedCall>,
    cursor: number,
  ): { match: LoadedCall; nextCursor: number; reason: null } | { match: null; nextCursor: number; reason: NoMatchReason } {
    const target = fingerprintRequest({
      provider: request.provider,
      model: request.model,
      messages: request.messages,
      ...(request.extras !== undefined ? { extras: request.extras } : {}),
    })
    for (let i = cursor; i < calls.length; i++) {
      const call = calls[i] as LoadedCall
      if (call.request.fingerprint === target) {
        return { match: call, nextCursor: i + 1, reason: null }
      }
    }
    return {
      match: null,
      nextCursor: cursor,
      reason: cursor >= calls.length ? 'exhausted' : 'fingerprint-mismatch',
    }
  }
}

/**
 * Fuzzy: pick the first call whose request shares a user-text prefix of at
 * least `minPrefixChars` characters with the live request. The match score
 * is the shared prefix length; ties break on recording order. This is the
 * strategy that lets a developer replay an old session against a slightly
 * changed prompt without re-recording.
 */
export class FuzzyStrategy implements ReplayerStrategy {
  readonly name: MatchStrategy = 'fuzzy'
  private readonly minPrefixChars: number

  constructor(options: { minPrefixChars?: number } = {}) {
    this.minPrefixChars = options.minPrefixChars ?? 16
    invariant(this.minPrefixChars > 0, 'FuzzyStrategy', 'minPrefixChars must be a positive integer')
  }

  nextMatch(
    request: RequestShape,
    calls: ReadonlyArray<LoadedCall>,
    cursor: number,
  ): { match: LoadedCall; nextCursor: number; reason: null } | { match: null; nextCursor: number; reason: NoMatchReason } {
    if (cursor >= calls.length) return { match: null, nextCursor: cursor, reason: 'exhausted' }
    const liveText = collectText(request.messages)
    let best: { match: LoadedCall; score: number; index: number } | null = null
    for (let i = cursor; i < calls.length; i++) {
      const call = calls[i] as LoadedCall
      const recordedText = collectText(call.request.messages)
      const score = sharedPrefixLength(liveText, recordedText)
      if (score >= this.minPrefixChars && (best === null || score > best.score)) {
        best = { match: call, score, index: i }
      }
    }
    if (best === null) {
      return {
        match: null,
        nextCursor: cursor,
        reason: cursor >= calls.length ? 'exhausted' : 'fingerprint-mismatch',
      }
    }
    return { match: best.match, nextCursor: best.index + 1, reason: null }
  }
}

/** Build a strategy by name. */
export function buildStrategy(name: MatchStrategy, options: { minPrefixChars?: number } = {}): ReplayerStrategy {
  switch (name) {
    case 'sequential':
      return new SequentialStrategy()
    case 'exact':
      return new ExactStrategy()
    case 'fuzzy':
      return new FuzzyStrategy(options)
  }
}

/** Collect every text leaf of the request messages, joined by newlines. */
function collectText(messages: ReadonlyArray<Message>): string {
  const parts: string[] = []
  for (const message of messages) {
    collectTextFromValue(message, parts)
  }
  return parts.join('\n')
}

function collectTextFromValue(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFromValue(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectTextFromValue(item, out)
  }
}

/** Length of the longest shared prefix between two strings. */
function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/** Mark a fingerprint in error messages. */
export function describeFingerprint(fingerprint: RequestFingerprint): string {
  return `fingerprint=${fingerprint}`
}

/** Re-export {@link GenerateOptions} so consumers do not need a second import. */
export type { GenerateOptions }
