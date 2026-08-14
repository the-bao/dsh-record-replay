import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayerAdapter, ReplayError, inspectFixture } from '../src/replayer.ts'
import { openWriter } from '../src/fixture.ts'
import type { StreamChunk } from '../src/types.ts'

function writeFixture(file: string): void {
  const writer = openWriter({ file, provider: 'p', model: 'm' })
  const request1 = {
    callId: 'a',
    fingerprint: 'fp-a' as never,
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: 'a' }] as never,
    startedAt: '2026-08-14T00:00:00.000Z',
  }
  writer.appendRequest(request1)
  writer.appendChunks({
    callId: 'a',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, delta: 'a' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'a' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    endedAt: '2026-08-14T00:00:01.000Z',
  })
  const request2 = {
    callId: 'b',
    fingerprint: 'fp-b' as never,
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: 'b' }] as never,
    startedAt: '2026-08-14T00:00:02.000Z',
  }
  writer.appendRequest(request2)
  writer.appendChunks({
    callId: 'b',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, delta: 'b' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'b' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    endedAt: '2026-08-14T00:00:03.000Z',
  })
  writer.close()
}

describe('ReplayerAdapter', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    file = join(dir, 'fixture.jsonl')
    writeFixture(file)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('replays calls in order with the default sequential strategy', async () => {
    const replayer = new ReplayerAdapter({ file })
    const collected: StreamChunk[] = []
    for await (const chunk of replayer.stream({ provider: 'p', model: 'm', messages: [] })) {
      collected.push(chunk)
    }
    expect(collected.length).toBe(4)
    const text = collected[2] as { type: 'block-end'; block: { text: string } }
    expect(text.block.text).toBe('a')
    expect(replayer.remaining).toBe(1)
  })

  it('replays the second call after the first', async () => {
    const replayer = new ReplayerAdapter({ file })
    for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) {
      /* drain */
    }
    const collected: StreamChunk[] = []
    for await (const chunk of replayer.stream({ provider: 'p', model: 'm', messages: [] })) {
      collected.push(chunk)
    }
    const text = collected[2] as { type: 'block-end'; block: { text: string } }
    expect(text.block.text).toBe('b')
    expect(replayer.remaining).toBe(0)
  })

  it('throws when the fixture is exhausted and onExhausted is throw', async () => {
    const replayer = new ReplayerAdapter({ file, onExhausted: 'throw' })
    for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) { /* drain */ }
    for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) { /* drain */ }
    await expect(async () => {
      for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) { /* drain */ }
    }).rejects.toThrow(/exhausted/)
  })

  it('reset() rewinds the cursor', async () => {
    const replayer = new ReplayerAdapter({ file })
    for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) { /* drain */ }
    expect(replayer.remaining).toBe(1)
    replayer.reset()
    expect(replayer.remaining).toBe(2)
  })

  it('replays a recorded failure as a ReplayError', async () => {
    const failureFile = join(dir, 'fail.jsonl')
    const writer = openWriter({ file: failureFile, provider: 'p', model: 'm' })
    writer.appendRequest({
      callId: 'x',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [],
      startedAt: '2026-08-14T00:00:00.000Z',
    })
    writer.appendFailure({
      callId: 'x',
      failure: { message: 'gone', code: 'GONE' },
      endedAt: '2026-08-14T00:00:01.000Z',
    })
    writer.close()
    const replayer = new ReplayerAdapter({ file: failureFile })
    await expect(async () => {
      for await (const _ of replayer.stream({ provider: 'p', model: 'm', messages: [] })) { /* drain */ }
    }).rejects.toBeInstanceOf(ReplayError)
  })
})

describe('inspectFixture', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the header and call list', () => {
    const file = join(dir, 'f.jsonl')
    writeFileSync(
      file,
      '{"kind":"header","version":"1.0","recordedAt":"x","provider":"p","model":"m","label":"demo"}\n',
      'utf8',
    )
    const fixture = inspectFixture(file)
    expect(fixture.header.label).toBe('demo')
    expect(fixture.calls.length).toBe(0)
  })
})
