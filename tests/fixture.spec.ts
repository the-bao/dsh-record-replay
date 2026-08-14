import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FixtureWriter,
  openWriter,
  readFixture,
  fingerprintRequest,
} from '../src/fixture.ts'
import { FIXTURE_VERSION } from '../src/types.ts'

describe('fingerprintRequest', () => {
  it('produces a stable hash for equal inputs', () => {
    const a = fingerprintRequest({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    const b = fingerprintRequest({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    expect(a).toBe(b)
  })

  it('changes when a message differs', () => {
    const a = fingerprintRequest({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    const b = fingerprintRequest({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'bye' }] as never,
    })
    expect(a).not.toBe(b)
  })

  it('changes when the model changes', () => {
    const a = fingerprintRequest({
      provider: 'p',
      model: 'a',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    const b = fingerprintRequest({
      provider: 'p',
      model: 'b',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    expect(a).not.toBe(b)
  })
})

describe('FixtureWriter', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    file = join(dir, 'fixture.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a header on open and reads it back', () => {
    const writer = new FixtureWriter({ file, provider: 'p', model: 'm', label: 'demo' })
    writer.close()
    const fixture = readFixture(file)
    expect(fixture.header.kind).toBe('header')
    expect(fixture.header.version).toBe(FIXTURE_VERSION)
    expect(fixture.header.provider).toBe('p')
    expect(fixture.header.model).toBe('m')
    expect(fixture.header.label).toBe('demo')
    expect(fixture.calls.length).toBe(0)
  })

  it('writes a request and a chunks record as a paired call', () => {
    const writer = new FixtureWriter({ file, provider: 'p', model: 'm' })
    const callId = FixtureWriter.newCallId()
    const fingerprint = fingerprintRequest({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
    })
    writer.appendRequest({
      callId,
      fingerprint,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
      startedAt: '2026-08-14T00:00:00.000Z',
    })
    writer.appendChunks({
      callId,
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, delta: 'hi' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      endedAt: '2026-08-14T00:00:01.000Z',
    })
    writer.close()
    const fixture = readFixture(file)
    expect(fixture.calls.length).toBe(1)
    expect(fixture.calls[0]!.outcome).toBe('chunks')
    expect(fixture.calls[0]!.chunks.chunks.length).toBe(4)
  })

  it('overwrites when overwrite: true', () => {
    const writer = new FixtureWriter({ file, provider: 'p', model: 'm', label: 'first' })
    writer.close()
    const writer2 = new FixtureWriter({ file, provider: 'p', model: 'm', overwrite: true })
    writer2.close()
    const fixture = readFixture(file)
    expect(fixture.header.label).toBeUndefined()
  })

  it('appends when overwrite: false (default)', () => {
    const writer = new FixtureWriter({ file, provider: 'p', model: 'm', label: 'first' })
    writer.close()
    const writer2 = new FixtureWriter({ file, provider: 'p', model: 'm' })
    writer2.close()
    const text = readFileSync(file, 'utf8')
    const headers = text.split('\n').filter(line => line.startsWith('{"kind":"header"'))
    expect(headers.length).toBe(2)
  })

  it('throws on append after close', () => {
    const writer = new FixtureWriter({ file, provider: 'p', model: 'm' })
    writer.close()
    expect(() => writer.appendRequest({
      callId: 'x',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [],
      startedAt: '2026-08-14T00:00:00.000Z',
    })).toThrow(/closed writer/)
  })

  it('openWriter produces a writer that writes a header on open', () => {
    const writer = openWriter({ file, provider: 'p', model: 'm' })
    writer.close()
    const fixture = readFixture(file)
    expect(fixture.header.provider).toBe('p')
  })
})

describe('readFixture', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws on an empty file', () => {
    const file = join(dir, 'empty.jsonl')
    writeFileSync(file, '', 'utf8')
    expect(() => readFixture(file)).toThrow(/empty/)
  })

  it('throws on a malformed JSON line in strict mode', () => {
    const file = join(dir, 'bad.jsonl')
    writeFileSync(file, '{"kind":"header","version":"1.0","recordedAt":"x","provider":"p","model":"m"}\n{not-json}\n', 'utf8')
    expect(() => readFixture(file)).toThrow(/line 2/)
  })

  it('skips a malformed line in non-strict mode', () => {
    const file = join(dir, 'bad.jsonl')
    writeFileSync(file, '{"kind":"header","version":"1.0","recordedAt":"x","provider":"p","model":"m"}\n{not-json}\n{"kind":"request","callId":"a","fingerprint":"x","provider":"p","model":"m","messages":[],"startedAt":"2026-08-14T00:00:00.000Z"}\n{"kind":"chunks","callId":"a","chunks":[],"endedAt":"2026-08-14T00:00:01.000Z"}\n', 'utf8')
    const fixture = readFixture(file, { strict: false })
    expect(fixture.calls.length).toBe(1)
  })

  it('throws on a request with no outcome in strict mode', () => {
    const file = join(dir, 'no-outcome.jsonl')
    writeFileSync(
      file,
      '{"kind":"header","version":"1.0","recordedAt":"x","provider":"p","model":"m"}\n'
      + '{"kind":"request","callId":"a","fingerprint":"x","provider":"p","model":"m","messages":[],"startedAt":"2026-08-14T00:00:00.000Z"}\n',
      'utf8',
    )
    expect(() => readFixture(file)).toThrow(/no outcome/)
  })

  it('orders calls by startedAt', () => {
    const file = join(dir, 'order.jsonl')
    writeFileSync(
      file,
      '{"kind":"header","version":"1.0","recordedAt":"x","provider":"p","model":"m"}\n'
      + '{"kind":"request","callId":"b","fingerprint":"x","provider":"p","model":"m","messages":[],"startedAt":"2026-08-14T00:00:02.000Z"}\n'
      + '{"kind":"chunks","callId":"b","chunks":[],"endedAt":"2026-08-14T00:00:03.000Z"}\n'
      + '{"kind":"request","callId":"a","fingerprint":"y","provider":"p","model":"m","messages":[],"startedAt":"2026-08-14T00:00:00.000Z"}\n'
      + '{"kind":"chunks","callId":"a","chunks":[],"endedAt":"2026-08-14T00:00:01.000Z"}\n',
      'utf8',
    )
    const fixture = readFixture(file)
    expect(fixture.calls.map((c) => c.request.callId)).toEqual(['a', 'b'])
  })
})
