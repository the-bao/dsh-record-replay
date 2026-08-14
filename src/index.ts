/**
 * Public entry point for `@dsh-contrib/dsh-record-replay`. The package
 * re-exports the recorder, replayer, fixture, and redact modules. The
 * strategy, diff, and merge modules are reachable through their own entry
 * points to keep the main bundle small for the recorder/replayer hot path.
 *
 * @module @dsh-contrib/dsh-record-replay
 */

export {
  RecorderAdapter,
  createRecorder,
  type RecorderAdapterOptions,
} from './recorder.ts'

export {
  ReplayerAdapter,
  ReplayError,
  inspectFixture,
  type ReplayerAdapterOptions,
} from './replayer.ts'

export {
  FixtureWriter,
  openWriter,
  readFixture,
  fingerprintRequest,
  type FixtureFailure,
  type LoadedCall,
  type LoadedFixture,
  type ReadFixtureOptions,
  type FixtureWriterOptions,
} from './fixture.ts'

export {
  redactRecord,
  redactRecords,
  type RedactOptions,
  type RedactionReport,
} from './redact.ts'

export {
  diffFixtures,
  type DiffEntry,
  type DiffResult,
} from './diff.ts'

export {
  mergeFixtures,
  writeMerge,
  type MergeOptions,
} from './merge.ts'

export {
  buildStrategy,
  SequentialStrategy,
  ExactStrategy,
  FuzzyStrategy,
  type ReplayerStrategy,
  type NoMatchReason,
} from './strategies.ts'

export type {
  FixtureHeader,
  FixtureRequest,
  FixtureChunks,
  FixtureRecord,
  FixtureVersion,
  RedactedField,
  RedactedFixtureRecord,
  LlmAdapterLike,
  MatchStrategy,
  RecorderOptions,
  ReplayerOptions,
  RecordedFailure,
  RequestFingerprint,
} from './types.ts'

export { FIXTURE_VERSION } from './types.ts'
