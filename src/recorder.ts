/**
 * Recorder: an LLM adapter that wraps another adapter and writes every
 * stream call to a JSONL fixture. The recorder is structural: it implements
 * the same `stream` shape as the dsh LLM adapter and registers with
 * `ctx.llm.registerAdapter(routes, instance)` like any other plugin.
 *
 * Recording is append-only and fsynced per record. A process crash mid-call
 * leaves a `request` without a matching `chunks`/`failure`; the loader flags
 * such calls as orphaned. The recorder itself never swallows exceptions: a
 * write failure aborts the in-flight stream, because a missing fixture
 * record is recoverable from a re-run, but a stream that lied about its
 * content is not.
 *
 * @module @dsh-contrib/dsh-record-replay/recorder
 */

import type { GenerateOptions, LlmAdapterLike, StreamChunk } from './types.ts'
import { FixtureWriter, extractExtras, fingerprintRequest } from './fixture.ts'
import { invariant } from './invariant.ts'

/** Minimal Cordis context shape the recorder reads. */
export interface RecorderContext {
  /** Optional structured logger; absent when the host has none. */
  readonly logger?: {
    error?: (...args: unknown[]) => void
  }
}

/** Options the recorder accepts at construction. */
export interface RecorderAdapterOptions {
  /** Provider route id; stamped into the fixture header. */
  readonly provider: string
  /** Model id; stamped into the fixture header. */
  readonly model: string
  /** Inner adapter whose stream calls are recorded. */
  readonly inner: LlmAdapterLike
  /** Writer the recorder appends to. */
  readonly writer: FixtureWriter
  /** Optional context used for logging when a write fails. */
  readonly context?: RecorderContext
}

/**
 * Structural LLM adapter that records every stream call. Register it with
 * `ctx.llm.registerAdapter(routes, recorder)` and the agent loop will route
 * matching calls through the inner adapter while mirroring them to disk.
 *
 * The recorder is invisible to the consumer: the yielded chunks are an
 * exact pass-through of the inner adapter's output. Buffering the full
 * stream per call makes the fixture atomic per call and avoids mid-call
 * interleaving if the loop yields control during pull.
 */
export class RecorderAdapter implements LlmAdapterLike {
  private readonly provider: string
  private readonly model: string
  private readonly inner: LlmAdapterLike
  private readonly writer: FixtureWriter
  private readonly context: RecorderContext
  /**
   * Per-call mutex. The agent loop does not issue overlapping `stream()`
   * calls on the same adapter, but a custom loop might; serialising here
   * keeps the writer non-racy without imposing a global lock.
   */
  private chain: Promise<void> = Promise.resolve()

  constructor(options: RecorderAdapterOptions) {
    this.provider = options.provider
    this.model = options.model
    this.inner = options.inner
    this.writer = options.writer
    this.context = options.context ?? {}
  }

  /**
   * Record one stream call. A request is written before the first chunk is
   * yielded; the chunks (or a failure) are written after the inner stream
   * completes. A throw from the inner adapter is propagated to the consumer
   * after the failure record is durably on disk.
   */
  async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    const callId = FixtureWriter.newCallId()
    const extras = extractExtras(options as unknown as Readonly<Record<string, unknown>>)
    const fingerprint = fingerprintRequest({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...(Object.keys(extras).length > 0 ? { extras } : {}),
    })
    const startedAt = new Date().toISOString()
    this.queueWrite(
      this.writer.appendRequest({
        callId,
        fingerprint,
        provider: options.provider,
        model: options.model,
        messages: options.messages,
        startedAt,
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      }),
    )

    const collected: StreamChunk[] = []
    try {
      for await (const chunk of this.inner.stream(options)) {
        collected.push(chunk)
        yield chunk
      }
      this.queueWrite(
        this.writer.appendChunks({
          callId,
          chunks: collected,
          endedAt: new Date().toISOString(),
        }),
      )
    } catch (error) {
      this.queueWrite(
        this.writer.appendFailure({
          callId,
          failure: {
            message: (error as Error).message,
            code: 'STREAM_THREW',
          },
          endedAt: new Date().toISOString(),
        }),
      )
      throw error
    }
  }

  /**
   * Flush the writer. The recorder is fire-and-forget; calling `flush()`
   * from a test's teardown ensures every queued write is durable before
   * the test asserts.
   */
  async flush(): Promise<void> {
    await this.chain
  }

  /** Close the writer. */
  close(): void {
    this.writer.close()
  }

  /** The file the recorder is writing to. Diagnostic. */
  get path(): string {
    return this.writer.path
  }

  private queueWrite(op: void | Promise<void>): void {
    this.chain = this.chain.then(() => op).catch((error) => {
      this.context.logger?.error?.('dsh-record-replay: fixture write failed', error)
    })
  }
}

/**
 * Convenience builder: open a writer and wrap an inner adapter. The returned
 * recorder is not yet registered with dsh; the caller still owns
 * `registerAdapter`.
 */
export function createRecorder(options: {
  provider: string
  model: string
  inner: LlmAdapterLike
  context?: RecorderContext
  file: string
  label?: string
  meta?: Readonly<Record<string, string>>
  overwrite?: boolean
}): RecorderAdapter {
  invariant(typeof options.file === 'string' && options.file.length > 0, 'createRecorder', 'file is required')
  const writer = new FixtureWriter({
    file: options.file,
    provider: options.provider,
    model: options.model,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.meta !== undefined ? { meta: options.meta } : {}),
    ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
  })
  return new RecorderAdapter({
    provider: options.provider,
    model: options.model,
    inner: options.inner,
    writer,
    context: options.context,
  })
}
