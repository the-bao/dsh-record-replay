import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffFixtures } from '../src/diff.ts'
import { openWriter, readFixture } from '../src/fixture.ts'
import { mergeFixtures } from '../src/merge.ts'
import type { LoadedFixture } from '../src/fixture.ts'

function writeLoaded(file: string, label: string, calls: Array<{ callId: string; text: string; outcome: 'chunks' | 'failure'; failureMessage?: string }>): void {
  const writer = openWriter({ file, provider: 'p', model: 'm', label })
  let n = 0
  for (const c of calls) {
    n += 1
    const startedAt = `2026-08-14T00:00:0${n}.000Z`
    writer.appendRequest({
      callId: c.callId,
      fingerprint: ('fp-' + c.callId) as never,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: c.text }] as never,
      startedAt,
    })
    if (c.outcome === 'chunks') {
      writer.appendChunks({
        callId: c.callId,
        chunks: [{ type: 'text-delta', index: 0, delta: c.text }, { type: 'finish', reason: { kind: 'stop' } }],
        endedAt: startedAt,
      })
    } else {
      writer.appendFailure({
        callId: c.callId,
        failure: { message: c.failureMessage ?? 'failed', code: 'ERR' },
        endedAt: startedAt,
      })
    }
  }
  writer.close()
}

describe('diffFixtures', () => {
  it('reports equivalent when both fixtures are identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    try {
      const a = join(dir, 'a.jsonl')
      const b = join(dir, 'b.jsonl')
      writeLoaded(a, 'one', [{ callId: 'a', text: 'a', outcome: 'chunks' }])
      writeLoaded(b, 'one', [{ callId: 'a', text: 'a', outcome: 'chunks' }])
      const result = diffFixtures(readFixture(a), readFixture(b))
      expect(result.equivalent).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports chunks-differ when one chunk changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    try {
      const a = join(dir, 'a.jsonl')
      const b = join(dir, 'b.jsonl')
      writeLoaded(a, 'one', [{ callId: 'a', text: 'hello', outcome: 'chunks' }])
      writeLoaded(b, 'one', [{ callId: 'a', text: 'hello', outcome: 'chunks' }])
      const bFixture = readFixture(b)
      const call = bFixture.calls[0]!
      if (call.outcome === 'chunks') {
        const chunks = call.chunks.chunks as Array<{ type: 'text-delta'; delta: string }>
        chunks[0]!.delta = 'world'
      }
      const result = diffFixtures(readFixture(a), bFixture)
      expect(result.equivalent).toBe(false)
      expect(result.entries.some((e) => e.kind === 'chunks-differ')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports missing-in-right when the right fixture is shorter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    try {
      const a = join(dir, 'a.jsonl')
      const b = join(dir, 'b.jsonl')
      writeLoaded(a, 'one', [
        { callId: 'a', text: 'a', outcome: 'chunks' },
        { callId: 'b', text: 'b', outcome: 'chunks' },
      ])
      writeLoaded(b, 'one', [{ callId: 'a', text: 'a', outcome: 'chunks' }])
      const result = diffFixtures(readFixture(a), readFixture(b))
      expect(result.entries.some((e) => e.kind === 'missing-in-right')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeFixtures', () => {
  it('concatenates two fixtures and writes a merged header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-record-replay-'))
    try {
      const a = join(dir, 'a.jsonl')
      const b = join(dir, 'b.jsonl')
      const out = join(dir, 'merged.jsonl')
      writeLoaded(a, 'first', [{ callId: 'a', text: 'a', outcome: 'chunks' }])
      writeLoaded(b, 'second', [{ callId: 'b', text: 'b', outcome: 'chunks' }])
      const { written, count } = mergeFixtures(a, b, { file: out, label: 'merged' })
      expect(written).toBe(out)
      expect(count).toBe(2)
      const merged = readFixture(out) as LoadedFixture
      expect(merged.header.label).toBe('merged')
      expect(merged.calls.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
