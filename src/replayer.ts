/**
 * Replayer: an LLM adapter that serves a recorded fixture instead of calling
 * a live provider. Three matching strategies are available: `sequential`
 * (the default; matches in recorded order), `exact` (matches by request
 * fingerprint), and `fuzzy` (matches by user-text prefix). All three
 * advance a per-adapter cursor so each live stream call consumes exactly
 * one recorded call.
 *
 * The replayer is a leaf adapter: register it with
 * `ctx.llm.registerAdapter(routes, instance)` and the agent loop will route
 * matching calls through it. A `request` whose recorded outcome is a
 * `chunks` payload is yielded verbatim; a recorded `failure` is reproduced
 * by throwing after the request record is consumed.
 *
 * @module @dsh-contrib/dsh-record-replay/replayer
 */

import type {
  GenerateOptions,
  LlmAdapterLike,
  MatchStrategy,
  StreamChunk,
} from './types.ts'
import {
  type LoadedCall,
  type LoadedFixture,
  readFixture,
} from './fixture.ts'
import { buildStrategy, type ReplayerStrategy } from './strategies.ts'
import { invariant } from './invariant.ts'
import { extractExtras } from './fixture.ts'

/** Options the replayer accepts at construction. */
export interface ReplayerAdapterOptions {
  /** File containing the fixture. Required. */
  readonly file: string
  /** Matching strategy. Defaults to `sequential`. */
  readonly strategy?: MatchStrategy
  /** Default provider when the live request omits one. */
  readonly defaultProvider?: string
  /** Default model when the live request omits one. */
  readonly defaultModel?: string
  /**
   * What to do when the live request would consume past the end of the
   * recorded script. `throw` (default) raises; `hang` keeps the stream open
   * with no chunks until cancellation.
   */
  readonly onExhausted?: 'throw' | 'hang'
  /** Optional fuzzy-strategy knob. Ignored by other strategies. */
  readonly minPrefixChars?: number
}

/** Build a replayer from an already-loaded fixture. */
export interface ReplayerAdapterLoadedOptions extends Omit<ReplayerAdapterOptions, 'file'> {
  readonly fixture: LoadedFixture
}

/**
 * The shared state is the cursor and the strategy; the fixture is read once
 * and re-used on every stream call. A test can construct a replayer with an
 * in-memory fixture; production use reads from disk.
 */
export class ReplayerAdapter implements LlmAdapterLike {
  private readonly fixture: LoadedFixture
  private readonly strategy: ReplayerStrategy
  private readonly defaultProvider?: string
  private readonly defaultModel?: string
  private readonly onExhausted: 'throw' | 'hang'
  private cursor = 0

  constructor(options: ReplayerAdapterOptions) {
    const fixture = readFixture(options.file)
    this.fixture = fixture
    this.strategy = buildStrategy(options.strategy ?? 'sequential', {
      ...(options.minPrefixChars !== undefined ? { minPrefixChars: options.minPrefixChars } : {}),
    })
    this.defaultProvider = options.defaultProvider
    this.defaultModel = options.defaultModel
    this.onExhausted = options.onExhausted ?? 'throw'
  }

  /** Private constructor for tests that already have a parsed fixture. */
  static fromLoaded(options: ReplayerAdapterLoadedOptions): ReplayerAdapter {
    const replayer = Object.create(ReplayerAdapter.prototype) as ReplayerAdapter
    Object.assign(replayer, {
      fixture: options.fixture,
      strategy: buildStrategy(options.strategy ?? 'sequential', {
        ...(options.minPrefixChars !== undefined ? { minPrefixChars: options.minPrefixChars } : {}),
      }),
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      onExhausted: options.onExhausted ?? 'throw',
      cursor: 0,
    })
    return replayer
  }

  /**
   * Replay one stream call. The strategy picks the next recorded call; the
   * recorded chunks (or a thrown failure) are returned to the consumer.
   * A live request that would exhaust the fixture follows `onExhausted`.
   */
  async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    const provider = options.provider ?? this.defaultProvider ?? this.fixture.header.provider
    const model = options.model ?? this.defaultModel ?? this.fixture.header.model
    const liveExtras = extractExtras(options as unknown as Readonly<Record<string, unknown>>)
    const match = this.strategy.nextMatch(
      {
        provider,
        model,
        messages: options.messages,
        ...(Object.keys(liveExtras).length > 0 ? { extras: liveExtras } : {}),
      },
      this.fixture.calls,
      this.cursor,
    )
    if (match.match === null) {
      if (this.onExhausted === 'throw') {
        const verb = match.reason === 'exhausted' ? 'exhausted' : 'had no matching record'
        throw new Error(
          `dsh-record-replay: replayer script ${verb} at cursor=${this.cursor}/${this.fixture.calls.length}`
          + ` for provider=${provider}`
          + `, model=${model}; pass onExhausted: 'hang' to wait instead`,
        )
      }
      // hang: wait for cancellation. The agent loop cancels through the
      // outer iterator's return(); reaching this await means we keep the
      // call slot open until the consumer (or a test) tears it down.
      await new Promise<never>(() => {
        /* never resolves */
      })
      return
    }
    this.cursor = match.nextCursor
    if (match.match.outcome === 'failure') {
      throw new ReplayError(
        match.match.failure.failure.message,
        match.match.failure.failure.code,
        match.match.failure.callId,
      )
    }
    for (const chunk of match.match.chunks.chunks) {
      yield chunk
    }
  }

  /** The fixture's header. */
  get header(): LoadedFixture['header'] {
    return this.fixture.header
  }

  /** The fixture's calls. */
  get calls(): ReadonlyArray<LoadedCall> {
    return this.fixture.calls
  }

  /** The current cursor position. Diagnostic. */
  get remaining(): number {
    return Math.max(0, this.fixture.calls.length - this.cursor)
  }

  /**
   * Reset the cursor so the fixture is replayable from the start. Useful in
   * tests that re-run a scenario.
   */
  reset(): void {
    this.cursor = 0
  }
}

/**
 * Thrown by the replayer when a recorded call ended in a failure. The
 * `code` is whatever the recorder captured; `callId` is the recorded id.
 */
export class ReplayError extends Error {
  readonly code: string
  readonly callId: string
  constructor(message: string, code: string, callId: string) {
    super(message)
    this.name = 'ReplayError'
    this.code = code
    this.callId = callId
  }
}

/**
 * Read a fixture file and return the parsed fixture without constructing a
 * replayer. Useful for the CLI's `inspect` and `diff` commands.
 */
export function inspectFixture(file: string): LoadedFixture {
  invariant(typeof file === 'string' && file.length > 0, 'inspectFixture', 'file is required')
  return readFixture(file)
}
