// Generate a sample fixture for the README. This script is also a worked
// example: a developer can copy it and adapt the messages to record a real
// session.

import { openWriter, FixtureWriter } from '../lib/fixture.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, 'sample-fixture.jsonl')
const writer = openWriter({
  file,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  label: 'sample-conversation',
  meta: { recordedBy: 'examples/generate-fixture.mjs' },
})

const callA = FixtureWriter.newCallId()
writer.appendRequest({
  callId: callA,
  fingerprint: 'fp-a',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is 2 + 2?' },
  ],
  extras: { temperature: 0.7, maxTokens: 256 },
  startedAt: '2026-08-14T12:00:00.000Z',
})
writer.appendChunks({
  callId: callA,
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, delta: '2 + 2 = ' },
    { type: 'text-delta', index: 0, delta: '4.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '2 + 2 = 4.' } },
    { type: 'usage', usage: { inputTokens: 18, outputTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
  endedAt: '2026-08-14T12:00:01.420Z',
})

const callB = FixtureWriter.newCallId()
writer.appendRequest({
  callId: callB,
  fingerprint: 'fp-b',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is 2 + 2?' },
    { role: 'assistant', content: '2 + 2 = 4.' },
    { role: 'user', content: 'And 3 + 3?' },
  ],
  extras: { temperature: 0.7, maxTokens: 256 },
  startedAt: '2026-08-14T12:00:02.000Z',
})
writer.appendChunks({
  callId: callB,
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, delta: '3 + 3 = 6.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '3 + 3 = 6.' } },
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
  endedAt: '2026-08-14T12:00:03.120Z',
})

writer.close()
console.log(`wrote ${file}`)
