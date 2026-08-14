import { describe, it, expect } from 'vitest'
import { SequentialStrategy, ExactStrategy, FuzzyStrategy } from '../src/strategies.ts'
import { fingerprintRequest } from '../src/fixture.ts'
import type { LoadedCall } from '../src/fixture.ts'
import type { RequestFingerprint } from '../src/types.ts'

function call(id: string, text: string, startedAt: string): LoadedCall {
  const fingerprint = fingerprintRequest({
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: text }] as never,
  })
  return {
    request: {
      kind: 'request',
      callId: id,
      fingerprint,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: text }] as never,
      startedAt,
    },
    outcome: 'chunks',
    chunks: {
      kind: 'chunks',
      callId: id,
      chunks: [{ type: 'finish', reason: { kind: 'stop' } }],
      endedAt: startedAt,
    },
  }
}

describe('SequentialStrategy', () => {
  it('returns the call at the cursor', () => {
    const calls = [call('a', 'a', '2026-08-14T00:00:00.000Z'), call('b', 'b', '2026-08-14T00:00:01.000Z')]
    const strategy = new SequentialStrategy()
    const first = strategy.nextMatch({ provider: 'p', model: 'm', messages: [] }, calls, 0)
    expect(first.reason).toBeNull()
    expect(first.match?.request.callId).toBe('a')
    const second = strategy.nextMatch({ provider: 'p', model: 'm', messages: [] }, calls, 1)
    expect(second.match?.request.callId).toBe('b')
  })

  it('returns exhausted when the cursor is past the end', () => {
    const calls = [call('a', 'a', '2026-08-14T00:00:00.000Z')]
    const strategy = new SequentialStrategy()
    const result = strategy.nextMatch({ provider: 'p', model: 'm', messages: [] }, calls, 1)
    expect(result.match).toBeNull()
    expect(result.reason).toBe('exhausted')
  })
})

describe('ExactStrategy', () => {
  it('matches by fingerprint', () => {
    const recorded = call('a', 'hello world', '2026-08-14T00:00:00.000Z')
    const strategy = new ExactStrategy()
    const result = strategy.nextMatch(
      { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hello world' }] as never },
      [recorded],
      0,
    )
    expect(result.match?.request.callId).toBe('a')
  })

  it('returns fingerprint-mismatch when no call shares the fingerprint', () => {
    const recorded = call('a', 'hello', '2026-08-14T00:00:00.000Z')
    const strategy = new ExactStrategy()
    const result = strategy.nextMatch(
      { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'different' }] as never },
      [recorded],
      0,
    )
    expect(result.match).toBeNull()
    expect(result.reason).toBe('fingerprint-mismatch')
  })
})

describe('FuzzyStrategy', () => {
  it('matches by user-text prefix above the threshold', () => {
    const recorded = call('a', 'hello world how are you', '2026-08-14T00:00:00.000Z')
    const strategy = new FuzzyStrategy({ minPrefixChars: 5 })
    const result = strategy.nextMatch(
      { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hello world today' }] as never },
      [recorded],
      0,
    )
    expect(result.match?.request.callId).toBe('a')
  })

  it('returns fingerprint-mismatch when the prefix is too short', () => {
    const recorded = call('a', 'hello world', '2026-08-14T00:00:00.000Z')
    const strategy = new FuzzyStrategy({ minPrefixChars: 100 })
    const result = strategy.nextMatch(
      { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hello world' }] as never },
      [recorded],
      0,
    )
    expect(result.match).toBeNull()
  })
})

describe('fingerprintRequest brand', () => {
  it('casts a hash to RequestFingerprint', () => {
    const fp: RequestFingerprint = 'abc123' as RequestFingerprint
    expect(typeof fp).toBe('string')
  })
})
