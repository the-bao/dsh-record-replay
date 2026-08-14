/**
 * Re-export the dsh-llm streaming vocabulary so consumers do not need to
 * add a second peer dependency to type a recorder or replayer. The dsh-llm
 * union types are referenced by name; the file ships no runtime value from
 * dsh-llm, so a build of this package that never imports the dsh runtime is
 * itself valid (the dsh types are erased by `verbatimModuleSyntax` and the
 * peer declaration).
 *
 * The package's adapters (recorder, replayer) intentionally implement a
 * structural `LlmAdapter` rather than extending the dsh abstract class.
 * `registerAdapter(routes, adapter)` accepts anything with a `stream` method;
 * structural compatibility keeps this plugin peer-dep-free at the value level.
 *
 * @module @dsh-contrib/dsh-record-replay/types
 */

import type { StreamChunk, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export type { StreamChunk, GenerateOptions, Message }

/**
 * Structural LLM adapter: a class with a single `stream` method that yields
 * provider-neutral `StreamChunk` values. The recorder and replayer both
 * implement this; `ctx.llm.registerAdapter(routes, instance)` accepts any
 * value whose `stream` signature matches, so dsh's abstract `LlmAdapter` is
 * not extended here.
 */
export interface LlmAdapterLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Stable schema version of a fixture file. Bumped only on a breaking wire
 * format change. Older fixtures can be migrated by reading the header and
 * rewriting the records.
 */
export const FIXTURE_VERSION = '1.0' as const

/** Schema version of a fixture file. */
export type FixtureVersion = typeof FIXTURE_VERSION | `${number}.${number}`

/** Provider route the recording targeted. */
export interface FixtureHeader {
  readonly kind: 'header'
  readonly version: FixtureVersion
  /** Wall-clock recording time in ISO 8601. Diagnostic only. */
  readonly recordedAt: string
  /** Provider route id used during recording. */
  readonly provider: string
  /** Model id used during recording. */
  readonly model: string
  /** Optional human-readable label for the scenario. */
  readonly label?: string
  /** Optional caller-supplied metadata (test name, build id, ...). Diagnostic only. */
  readonly meta?: Readonly<Record<string, string>>
}

/** Hash of the request fingerprint, used by the replayer to match calls to scripts. */
export type RequestFingerprint = string & { readonly __brand: 'RequestFingerprint' }

/**
 * Persisted form of one model call: a request followed by its complete chunk
 * stream. The pair carries a shared `callId` so a fixture can be reordered.
 */
export interface FixtureRequest {
  readonly kind: 'request'
  readonly callId: string
  /** Hash of the request body, computed by {@link fingerprintRequest}. */
  readonly fingerprint: RequestFingerprint
  /** Provider route the request was made against. */
  readonly provider: string
  /** Model id the request named. */
  readonly model: string
  /** Recorded request messages, in the order the adapter received them. */
  readonly messages: ReadonlyArray<Message>
  /**
   * Recorded GenerateOptions fields that are neither the four routing fields
   * (`provider`, `model`, `messages`, `sessionId`) nor the cancellation
   * signal. Replay materialises these back into the live `GenerateOptions`
   * when the strategy matches the call, so a `system` slot, `tools` schema,
   * `temperature`, `maxTokens`, `stop`, `reasoningEffort`, or `purpose`
   * survives a record/replay round-trip.
   */
  readonly extras?: Readonly<Record<string, unknown>>
  /** Recorded start time, ISO 8601. */
  readonly startedAt: string
}

export interface FixtureChunks {
  readonly kind: 'chunks'
  readonly callId: string
  /** Full chunk sequence the adapter produced for the matching request. */
  readonly chunks: ReadonlyArray<StreamChunk>
  /** Recorded end time, ISO 8601. */
  readonly endedAt: string
}

/** A redacted marker — the original value is gone, only its kind and length are preserved. */
export interface RedactedField {
  readonly redacted: true
  /** Original JSON shape kind for diagnostics. */
  readonly shape: 'string' | 'number' | 'object' | 'array' | 'boolean' | 'null'
  /** UTF-16 length of the original value when it was a string. */
  readonly length?: number
  /** Stable hash of the original value when the caller asked for it. */
  readonly hash?: string
}

export type FixtureRecord = FixtureHeader | FixtureRequest | FixtureChunks

/**
 * A redacted record: a fixture with secrets and identifying fields replaced
 * by stable placeholders. Redaction preserves shape and length, never the
 * value, so a diff against the original reveals a redacted field with a
 * `RedactedField` in its place.
 */
export type RedactedFixtureRecord = FixtureRecord | {
  readonly kind: 'request'
  readonly callId: string
  readonly fingerprint: RequestFingerprint
  readonly provider: string
  readonly model: string
  readonly messages: ReadonlyArray<unknown>
  readonly extras?: Readonly<Record<string, unknown>>
  readonly startedAt: string
  readonly _redactedFields: ReadonlyArray<string>
}

/** Reason a recorded stream call failed. */
export interface RecordedFailure {
  readonly message: string
  readonly code: string
}

/** Strategy the replayer uses to match a live request to a recorded script. */
export type MatchStrategy =
  | 'sequential'
  | 'exact'
  | 'fuzzy'

/** Options the replayer accepts. */
export interface ReplayerOptions {
  /**
   * File containing the fixture. Required.
   */
  readonly file: string
  /**
   * How to match a live request to a recorded request. Defaults to
   * `sequential` (replay in recorded order, ignoring request content).
   */
  readonly strategy?: MatchStrategy
  /**
   * Optional provider route id to assume when the live request omits one.
   * Falls back to the recorded request's provider when also absent.
   */
  readonly defaultProvider?: string
  /**
   * Optional model id to assume when the live request omits one. Falls back
   * to the recorded request's model when also absent.
   */
  readonly defaultModel?: string
  /**
   * What to do when the live request would consume past the end of the
   * recorded script. `throw` (default) raises; `hang` keeps the stream open
   * with no chunks until cancellation.
   */
  readonly onExhausted?: 'throw' | 'hang'
}

/** Options the recorder accepts. */
export interface RecorderOptions {
  /**
   * File to append records to. Created on open if missing. The file is
   * flushed after every call so a crash never leaves the fixture truncated.
   */
  readonly file: string
  /**
   * Provider route the recorder is wrapping. Stamped into the header.
   */
  readonly provider: string
  /** Model id the recorder is wrapping. Stamped into the header. */
  readonly model: string
  /**
   * Optional human-readable label for the scenario. Diagnostic only.
   */
  readonly label?: string
  /**
   * Optional caller metadata merged into the header. Diagnostic only.
   */
  readonly meta?: Readonly<Record<string, string>>
}
