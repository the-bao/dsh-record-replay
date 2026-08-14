/**
 * JSONL fixture reader and writer. A fixture is a sequence of records, one
 * per line, each a JSON object with a `kind` discriminant. Records may be
 * interleaved: a `request` is always followed by a `chunks` (or a `failure`)
 * carrying the same `callId`, but a fixture may carry multiple calls and the
 * pairs are independently addressable by call id.
 *
 * The writer opens the file once, holds the descriptor, and fsyncs after
 * every record so a crash never leaves a half-written call on disk. The
 * reader streams and reorders by pairing request and chunks on the fly.
 *
 * @module @dsh-contrib/dsh-record-replay/fixture
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  FixtureHeader,
  FixtureRecord,
  FixtureRequest,
  FixtureChunks,
  Message,
  RecordedFailure,
  RequestFingerprint,
  StreamChunk,
} from './types.ts'
import { FIXTURE_VERSION } from './types.ts'
import { invariant } from './invariant.ts'

/** Computed fingerprint of one request body, used by the replayer to match. */
export function fingerprintRequest(input: {
  provider: string
  model: string
  messages: ReadonlyArray<Message>
  extras?: Readonly<Record<string, unknown>>
}): RequestFingerprint {
  const canonical = JSON.stringify({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    extras: input.extras ?? null,
  })
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return hash as RequestFingerprint
}

/**
 * Capture every GenerateOptions field that is NOT a routing or cancellation
 * field. The recorder writes the result as {@link FixtureRequest.extras};
 * the replayer merges the captured value back into a live `GenerateOptions`
 * when it materialises a recorded call. The contract is "the recorded
 * GenerateOptions minus `provider`, `model`, `messages`, `sessionId`, and
 * `signal`"; any field the dsh runtime adds later is captured automatically
 * without a plugin change.
 */
export function extractExtras(options: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const drop = new Set(['provider', 'model', 'messages', 'sessionId', 'signal'])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (!drop.has(key)) out[key] = value
  }
  return out
}

/** Distinguishing field set per record kind, used to reject unknown shapes. */
const HEADER_KEYS = ['kind', 'version', 'recordedAt', 'provider', 'model'] as const
const REQUEST_KEYS = ['kind', 'callId', 'fingerprint', 'provider', 'model', 'messages', 'startedAt'] as const
const CHUNKS_KEYS = ['kind', 'callId', 'chunks', 'endedAt'] as const
const FAILURE_KEYS = ['kind', 'callId', 'failure', 'endedAt'] as const

/**
 * A failure record mirrors a `chunks` record: a `request` is followed by
 * either a `chunks` or a `failure`, never both. Failure records carry enough
 * to reproduce a thrown stream on replay.
 */
export interface FixtureFailure {
  readonly kind: 'failure'
  readonly callId: string
  readonly failure: RecordedFailure
  readonly endedAt: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObject(value)) return false
  for (const v of Object.values(value)) if (typeof v !== 'string') return false
  return true
}

/** Validate one raw JSON-decoded object as a {@link FixtureHeader}. */
function readHeader(value: unknown, line: number): FixtureHeader {
  invariant(isObject(value), `fixture:line ${line}`, 'header must be an object')
  if (value['kind'] !== 'header') {
    throw new Error(`dsh-record-replay: fixture:line ${line} expected header, got kind=${JSON.stringify(value['kind'])}`)
  }
  for (const key of HEADER_KEYS) {
    invariant(Object.hasOwn(value, key), `fixture:line ${line}`, `header missing key ${key}`)
  }
  const version = value['version']
  invariant(typeof version === 'string', `fixture:line ${line}`, 'header version must be a string')
  const recordedAt = value['recordedAt']
  invariant(typeof recordedAt === 'string', `fixture:line ${line}`, 'header recordedAt must be a string')
  const provider = value['provider']
  invariant(typeof provider === 'string', `fixture:line ${line}`, 'header provider must be a string')
  const model = value['model']
  invariant(typeof model === 'string', `fixture:line ${line}`, 'header model must be a string')
  const label = value['label']
  invariant(label === undefined || typeof label === 'string', `fixture:line ${line}`, 'header label must be a string')
  const meta = value['meta']
  if (meta !== undefined) {
    invariant(isStringRecord(meta), `fixture:line ${line}`, 'header meta must be a string-valued object')
  }
  return {
    kind: 'header',
    version: version as FixtureHeader['version'],
    recordedAt,
    provider,
    model,
    ...(label !== undefined ? { label } : {}),
    ...(meta !== undefined ? { meta } : {}),
  }
}

function readRequest(value: unknown, line: number): FixtureRequest {
  invariant(isObject(value), `fixture:line ${line}`, 'request must be an object')
  if (value['kind'] !== 'request') {
    throw new Error(`dsh-record-replay: fixture:line ${line} expected request, got kind=${JSON.stringify(value['kind'])}`)
  }
  for (const key of REQUEST_KEYS) {
    invariant(Object.hasOwn(value, key), `fixture:line ${line}`, `request missing key ${key}`)
  }
  const callId = value['callId']
  invariant(typeof callId === 'string', `fixture:line ${line}`, 'request callId must be a string')
  const fingerprint = value['fingerprint']
  invariant(typeof fingerprint === 'string', `fixture:line ${line}`, 'request fingerprint must be a string')
  const provider = value['provider']
  invariant(typeof provider === 'string', `fixture:line ${line}`, 'request provider must be a string')
  const model = value['model']
  invariant(typeof model === 'string', `fixture:line ${line}`, 'request model must be a string')
  const messages = value['messages']
  invariant(Array.isArray(messages), `fixture:line ${line}`, 'request messages must be an array')
  const startedAt = value['startedAt']
  invariant(typeof startedAt === 'string', `fixture:line ${line}`, 'request startedAt must be a string')
  const extras = value['extras']
  invariant(
    extras === undefined || isObject(extras),
    `fixture:line ${line}`,
    'request extras must be an object when present',
  )
  return {
    kind: 'request',
    callId,
    fingerprint: fingerprint as RequestFingerprint,
    provider,
    model,
    messages: messages as ReadonlyArray<Message>,
    startedAt,
    ...(extras !== undefined ? { extras: extras as Readonly<Record<string, unknown>> } : {}),
  }
}

function readChunks(value: unknown, line: number): FixtureChunks {
  invariant(isObject(value), `fixture:line ${line}`, 'chunks must be an object')
  if (value['kind'] !== 'chunks') {
    throw new Error(`dsh-record-replay: fixture:line ${line} expected chunks, got kind=${JSON.stringify(value['kind'])}`)
  }
  for (const key of CHUNKS_KEYS) {
    invariant(Object.hasOwn(value, key), `fixture:line ${line}`, `chunks missing key ${key}`)
  }
  const callId = value['callId']
  invariant(typeof callId === 'string', `fixture:line ${line}`, 'chunks callId must be a string')
  const chunks = value['chunks']
  invariant(Array.isArray(chunks), `fixture:line ${line}`, 'chunks array must be present')
  const endedAt = value['endedAt']
  invariant(typeof endedAt === 'string', `fixture:line ${line}`, 'chunks endedAt must be a string')
  return {
    kind: 'chunks',
    callId,
    chunks: chunks as ReadonlyArray<StreamChunk>,
    endedAt,
  }
}

function readFailure(value: unknown, line: number): FixtureFailure {
  invariant(isObject(value), `fixture:line ${line}`, 'failure must be an object')
  if (value['kind'] !== 'failure') {
    throw new Error(`dsh-record-replay: fixture:line ${line} expected failure, got kind=${JSON.stringify(value['kind'])}`)
  }
  for (const key of FAILURE_KEYS) {
    invariant(Object.hasOwn(value, key), `fixture:line ${line}`, `failure missing key ${key}`)
  }
  const callId = value['callId']
  invariant(typeof callId === 'string', `fixture:line ${line}`, 'failure callId must be a string')
  const failure = value['failure']
  invariant(isObject(failure), `fixture:line ${line}`, 'failure.failure must be an object')
  const message = failure['message']
  const code = failure['code']
  invariant(typeof message === 'string', `fixture:line ${line}`, 'failure.message must be a string')
  invariant(typeof code === 'string', `fixture:line ${line}`, 'failure.code must be a string')
  const endedAt = value['endedAt']
  invariant(typeof endedAt === 'string', `fixture:line ${line}`, 'failure endedAt must be a string')
  return {
    kind: 'failure',
    callId,
    failure: { message, code },
    endedAt,
  }
}

/** Parse one JSON-decoded object into a {@link FixtureRecord} or {@link FixtureFailure}. */
function readRecord(value: unknown, line: number): FixtureRecord | FixtureFailure {
  invariant(isObject(value), `fixture:line ${line}`, 'record must be an object')
  switch (value['kind']) {
    case 'header':
      return readHeader(value, line)
    case 'request':
      return readRequest(value, line)
    case 'chunks':
      return readChunks(value, line)
    case 'failure':
      return readFailure(value, line)
    default:
      throw new Error(`dsh-record-replay: fixture:line ${line} unknown record kind ${JSON.stringify(value['kind'])}`)
  }
}

/** Options for {@link readFixture}. */
export interface ReadFixtureOptions {
  /**
   * Throw on an unknown `kind`, malformed record, or duplicate call id.
   * Defaults to `true`. Set `false` to allow tolerant reads (skip the
   * bad record and continue).
   */
  readonly strict?: boolean
}

/** Loaded fixture paired with all calls discovered. */
export interface LoadedFixture {
  /** Header record. */
  readonly header: FixtureHeader
  /**
   * Calls in the order they were recorded. Each call has a `request` and
   * either a `chunks` or `failure` payload.
   */
  readonly calls: ReadonlyArray<LoadedCall>
}

/** One call discovered in a fixture: a request and its outcome. */
export type LoadedCall = {
  readonly request: FixtureRequest
} & (
  | { readonly outcome: 'chunks'; readonly chunks: FixtureChunks }
  | { readonly outcome: 'failure'; readonly failure: FixtureFailure }
)

/**
 * Load a fixture file into memory. Parses all records, validates each, and
 * pairs requests with their chunks or failure. Throws on a malformed record,
 * a duplicate call id, or a `chunks`/`failure` record without a matching
 * `request`.
 */
export function readFixture(file: string, options: ReadFixtureOptions = {}): LoadedFixture {
  const strict = options.strict ?? true
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) throw new Error(`dsh-record-replay: fixture ${file} is empty`)

  let header: FixtureHeader
  try {
    header = readHeader(JSON.parse(lines[0] as string), 1)
  } catch (error) {
    throw new Error(`dsh-record-replay: fixture ${file} line 1 invalid header: ${(error as Error).message}`)
  }
  const records: Array<FixtureRequest | FixtureChunks | FixtureFailure> = []
  for (let i = 1; i < lines.length; i++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i] as string)
    } catch (error) {
      if (!strict) continue
      throw new Error(`dsh-record-replay: fixture ${file} line ${i + 1} invalid JSON: ${(error as Error).message}`)
    }
    let record: FixtureRecord | FixtureFailure
    try {
      record = readRecord(parsed, i + 1)
    } catch (error) {
      if (!strict) continue
      throw new Error(`dsh-record-replay: fixture ${file} line ${i + 1} invalid record: ${(error as Error).message}`)
    }
    if (record.kind === 'header') {
      if (!strict) continue
      throw new Error(`dsh-record-replay: fixture ${file} line ${i + 1} has duplicate header`)
    }
    records.push(record)
  }

  const byCall = new Map<string, { request?: FixtureRequest; chunks?: FixtureChunks; failure?: FixtureFailure }>()
  for (const record of records) {
    const bucket = byCall.get(record.callId) ?? {}
    if (record.kind === 'request') {
      if (bucket.request !== undefined) {
        if (!strict) continue
        throw new Error(`dsh-record-replay: fixture ${file} duplicate request for callId=${record.callId}`)
      }
      bucket.request = record
    } else if (record.kind === 'chunks') {
      if (bucket.chunks !== undefined || bucket.failure !== undefined) {
        if (!strict) continue
        throw new Error(`dsh-record-replay: fixture ${file} duplicate outcome for callId=${record.callId}`)
      }
      bucket.chunks = record
    } else {
      if (bucket.chunks !== undefined || bucket.failure !== undefined) {
        if (!strict) continue
        throw new Error(`dsh-record-replay: fixture ${file} duplicate outcome for callId=${record.callId}`)
      }
      bucket.failure = record
    }
    byCall.set(record.callId, bucket)
  }

  const calls: LoadedCall[] = []
  for (const [, bucket] of byCall) {
    if (bucket.request === undefined) {
      if (!strict) continue
      throw new Error(
        `dsh-record-replay: fixture ${file} outcome without request for callId=${bucket.chunks?.callId ?? bucket.failure?.callId ?? '?'}`,
      )
    }
    if (bucket.chunks !== undefined) {
      calls.push({ request: bucket.request, outcome: 'chunks', chunks: bucket.chunks })
    } else if (bucket.failure !== undefined) {
      calls.push({ request: bucket.request, outcome: 'failure', failure: bucket.failure })
    } else if (strict) {
      throw new Error(`dsh-record-replay: fixture ${file} callId=${bucket.request.callId} has no outcome`)
    }
  }
  // Sort by startedAt to keep an inspection view deterministic.
  calls.sort((a, b) => a.request.startedAt.localeCompare(b.request.startedAt))
  return { header, calls }
}

/** Options for {@link openWriter}. */
export interface FixtureWriterOptions {
  /** File to append to. Created if missing. The header is written immediately. */
  readonly file: string
  /** Provider route the recorder is wrapping. Stamped into the header. */
  readonly provider: string
  /** Model id the recorder is wrapping. Stamped into the header. */
  readonly model: string
  /** Optional human-readable label for the scenario. */
  readonly label?: string
  /** Optional caller metadata merged into the header. Diagnostic only. */
  readonly meta?: Readonly<Record<string, string>>
  /**
   * Overwrite the file if it already exists. Default is to append. A header
   * is always written on open, so re-using a file with `append` produces
   * multiple headers (loaders handle this with `strict: false`); `overwrite`
   * is the right choice for a fresh recording.
   */
  readonly overwrite?: boolean
}

/**
 * Append-only writer for fixture records. Each method writes one line and
 * fsyncs the descriptor so a process crash never leaves a half-written
 * record on disk. The writer is single-threaded: concurrent writes from
 * parallel stream calls must be serialised by the caller (the recorder
 * uses a per-instance mutex).
 */
export class FixtureWriter {
  private readonly file: string
  private readonly fd: number
  private closed = false

  constructor(options: FixtureWriterOptions) {
    mkdirSync(dirname(options.file), { recursive: true })
    this.file = options.file
    const flags = options.overwrite ? 'w' : 'a'
    this.fd = openSync(this.file, flags)
    this.writeLine({
      kind: 'header',
      version: FIXTURE_VERSION,
      recordedAt: new Date().toISOString(),
      provider: options.provider,
      model: options.model,
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.meta !== undefined ? { meta: options.meta } : {}),
    })
  }

  /** Append one request record. The call id is generated if absent. */
  appendRequest(request: Omit<FixtureRequest, 'kind'>): void {
    this.guard()
    this.writeLine({ kind: 'request', ...request })
  }

  /** Append one chunks record. */
  appendChunks(chunks: Omit<FixtureChunks, 'kind'>): void {
    this.guard()
    this.writeLine({ kind: 'chunks', ...chunks })
  }

  /** Append one failure record. */
  appendFailure(failure: Omit<FixtureFailure, 'kind'>): void {
    this.guard()
    this.writeLine({ kind: 'failure', ...failure })
  }

  /** Close the descriptor. Subsequent appends throw. */
  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
  }

  /** The file the writer is bound to. */
  get path(): string {
    return this.file
  }

  /**
   * Build a fresh call id, unique within the process. Used by the recorder
   * when it opens a new stream call.
   */
  static newCallId(): string {
    return randomUUID()
  }

  private writeLine(value: Record<string, unknown>): void {
    const line = JSON.stringify(value) + '\n'
    const buf = Buffer.from(line, 'utf8')
    writeSync(this.fd, buf, 0, buf.length, null)
    fsyncSync(this.fd)
  }

  private guard(): void {
    invariant(!this.closed, 'FixtureWriter', 'cannot append to a closed writer')
  }
}

/** Open a writer with a stamped header. The header is written immediately. */
export function openWriter(options: FixtureWriterOptions): FixtureWriter {
  return new FixtureWriter(options)
}
