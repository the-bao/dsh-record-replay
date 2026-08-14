import { describe, it, expect } from 'vitest'
import { redactRecord, redactRecords } from '../src/redact.ts'
import type { FixtureRequest } from '../src/types.ts'

describe('redactRecord', () => {
  it('replaces a string field at a configured path', () => {
    const record: FixtureRequest = {
      kind: 'request',
      callId: 'a',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [],
      extras: { apiKey: 'sk-supersecret' },
      startedAt: '2026-08-14T00:00:00.000Z',
    }
    const { record: redacted, report } = redactRecord(record)
    const extras = (redacted as { extras?: Record<string, unknown> }).extras
    const apiKey = extras?.['apiKey'] as { redacted: true; shape: 'string'; length?: number }
    expect(apiKey.redacted).toBe(true)
    expect(apiKey.shape).toBe('string')
    expect(apiKey.length).toBe(14) // 'sk-supersecret' is 14 chars
    expect(report.count).toBe(1)
    expect(report.paths).toContain('extras.apiKey')
  })

  it('preserves the original structure for non-redacted fields', () => {
    const record: FixtureRequest = {
      kind: 'request',
      callId: 'a',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }] as never,
      extras: { temperature: 0.7 },
      startedAt: '2026-08-14T00:00:00.000Z',
    }
    const { record: redacted } = redactRecord(record)
    const extras = (redacted as { extras?: Record<string, unknown> }).extras
    expect(extras?.['temperature']).toBe(0.7)
  })

  it('adds a stable hash when withHash is true', () => {
    const record: FixtureRequest = {
      kind: 'request',
      callId: 'a',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [],
      extras: { apiKey: 'sk-supersecret' },
      startedAt: '2026-08-14T00:00:00.000Z',
    }
    const { record: redacted } = redactRecord(record, { withHash: true })
    const extras = (redacted as { extras?: Record<string, unknown> }).extras
    const apiKey = extras?.['apiKey'] as { redacted: true; hash?: string }
    expect(typeof apiKey.hash).toBe('string')
    expect(apiKey.hash?.length).toBe(12)
  })

  it('redacts the system prompt path', () => {
    const record: FixtureRequest = {
      kind: 'request',
      callId: 'a',
      fingerprint: 'fp' as never,
      provider: 'p',
      model: 'm',
      messages: [],
      extras: { system: 'You are a helpful assistant.' },
      startedAt: '2026-08-14T00:00:00.000Z',
    }
    const { record: redacted } = redactRecord(record, { paths: [['extras', 'system']] })
    const extras = (redacted as { extras?: Record<string, unknown> }).extras
    const sys = extras?.['system'] as { redacted: true; length?: number }
    expect(sys.redacted).toBe(true)
    expect(sys.length).toBe(28)
  })
})

describe('redactRecords', () => {
  it('sums the report across all records', () => {
    const records: FixtureRequest[] = [
      {
        kind: 'request',
        callId: 'a',
        fingerprint: 'fp' as never,
        provider: 'p',
        model: 'm',
        messages: [],
        extras: { apiKey: 'first' },
        startedAt: '2026-08-14T00:00:00.000Z',
      },
      {
        kind: 'request',
        callId: 'b',
        fingerprint: 'fp' as never,
        provider: 'p',
        model: 'm',
        messages: [],
        extras: { apiKey: 'second' },
        startedAt: '2026-08-14T00:00:01.000Z',
      },
    ]
    const { report } = redactRecords(records)
    expect(report.count).toBe(2)
  })
})
