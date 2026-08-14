import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecorderAdapter, createRecorder } from '../src/recorder.ts'
import { openWriter } from '../src/fixture.ts'
import type { GenerateOptions, LlmAdapterLike, StreamChunk } from '../src/types.ts'

/** A minimal stub context for the recorder. */
function stubContext(): never {
  return undefined as never
}

class StubAdapter implements LlmAdapterLike {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly responses: ReadonlyArray<AsyncIterable<StreamChunk> | Error>) {}
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response instanceof Error) {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw response
            },
          }
        },
      }
    }
    return response
  }
}

async function* chunks(values: ReadonlyArray<StreamChunk>): AsyncIterable<StreamChunk> {
  for (const v of values) yield v
}

describe('RecorderAdapter', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    file = join(dir, 'fixture.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a request and chunks for a successful call', async () => {
    const inner = new StubAdapter([
      chunks([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, delta: 'hi' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    ])
    const writer = openWriter({ file, provider: 'p', model: 'm' })
    const recorder = new RecorderAdapter({ provider: 'p', model: 'm', inner, writer, context: stubContext() })
    const collected: StreamChunk[] = []
    for await (const chunk of recorder.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hi' }] as never })) {
      collected.push(chunk)
    }
    await recorder.flush()
    recorder.close()
    expect(collected.length).toBe(4)
    // The recorder must not mutate the chunk sequence the consumer sees.
    expect(collected[0]?.type).toBe('block-start')
    expect(collected[3]?.type).toBe('finish')
  })

  it('writes a failure record when the inner adapter throws', async () => {
    const inner = new StubAdapter([new Error('boom')])
    const writer = openWriter({ file, provider: 'p', model: 'm' })
    const recorder = new RecorderAdapter({ provider: 'p', model: 'm', inner, writer, context: stubContext() })
    await expect(async () => {
      for await (const _ of recorder.stream({ provider: 'p', model: 'm', messages: [] })) {
        // drain
      }
    }).rejects.toThrow('boom')
    await recorder.flush()
    recorder.close()
    const fixture = (await import('../src/fixture.ts')).readFixture(file)
    expect(fixture.calls.length).toBe(1)
    expect(fixture.calls[0]!.outcome).toBe('failure')
    if (fixture.calls[0]!.outcome === 'failure') {
      expect(fixture.calls[0]!.failure.failure.code).toBe('STREAM_THREW')
      expect(fixture.calls[0]!.failure.failure.message).toBe('boom')
    }
  })

  it('records the request options when present', async () => {
    const inner = new StubAdapter([chunks([{ type: 'finish', reason: { kind: 'stop' } }])])
    const writer = openWriter({ file, provider: 'p', model: 'm' })
    const recorder = new RecorderAdapter({ provider: 'p', model: 'm', inner, writer, context: stubContext() })
    const options = {
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
      temperature: 0.7,
    } as never as GenerateOptions
    for await (const _ of recorder.stream(options)) {
      // drain
    }
    await recorder.flush()
    recorder.close()
    const fixture = (await import('../src/fixture.ts')).readFixture(file)
    const request = fixture.calls[0]!.request
    expect(request.extras).toEqual({ temperature: 0.7 })
  })

  it('createRecorder wires the writer and writer path', async () => {
    const inner = new StubAdapter([chunks([{ type: 'finish', reason: { kind: 'stop' } }])])
    const recorder = createRecorder({
      provider: 'p',
      model: 'm',
      inner,
      context: stubContext(),
      file,
      label: 'demo',
    })
    for await (const _ of recorder.stream({ provider: 'p', model: 'm', messages: [] })) {
      // drain
    }
    await recorder.flush()
    recorder.close()
    const fixture = (await import('../src/fixture.ts')).readFixture(file)
    expect(fixture.header.label).toBe('demo')
  })
})
