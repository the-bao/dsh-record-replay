# dsh-record-replay

English | [中文](#中文)

Record and replay DeepSeek Harness (`dsh`) LLM calls. The companion to
`@deepseek-ai/dsh-llm-replay`: where the official `dsh-llm-replay` is a
*keyless snapshot-test adapter* that derives replay scripts from recorded
session JSONL, **`dsh-record-replay` is the user-facing tooling** that lets
you record a real session into a portable fixture, redact secrets, diff two
fixtures, and merge or slice them — all from a tiny CLI.

## Why this exists

`dsh` opens every agent-loop call as a stream of `StreamChunk` values. The
recorder wraps any `LlmAdapter` and mirrors every call to a JSONL fixture;
the replayer consumes the same fixture and emits the recorded chunk stream
back through a real `LlmAdapter` shape so it can be registered with
`ctx.llm.registerAdapter(routes, instance)` like any native adapter. The CLI
handles the offline workflow.

A typical flow:

1. **Record** a real session once, against the DeepSeek provider or a
   self-hosted gateway.
2. **Redact** the fixture (remove API keys, system prompts, identifying
   metadata) before sharing it.
3. **Replay** the redacted fixture locally, in CI, or in a teammate's
   sandbox — no API key, no network, deterministic output.
4. **Diff** two fixtures to detect a regression in a model or a prompt.
5. **Merge** multiple session fixtures into one wide regression pack.

## Install

```sh
npm install @dsh-contrib/dsh-record-replay
```

The package needs `@deepseek-ai/dsh-llm` at runtime (peer dependency).
The recorder, replayer, and `dsh-rec` CLI all work in a stock Node 20+ ESM
process — no Cordis registration required unless you want to mount the
plugin through the Loader.

## Quick start

### Generate a fixture

```sh
# Produce a 2-call sample fixture (committed under examples/).
node examples/generate-fixture.mjs
```

```jsonl
{"kind":"header","version":"1.0","recordedAt":"...","provider":"deepseek-official","model":"deepseek-v4-flash","label":"sample-conversation"}
{"kind":"request","callId":"...","fingerprint":"fp-a","provider":"deepseek-official","model":"deepseek-v4-flash","messages":[...],"extras":{"temperature":0.7,"maxTokens":256},"startedAt":"..."}
{"kind":"chunks","callId":"...","chunks":[{"type":"block-start",...},...],"endedAt":"..."}
```

### Inspect a fixture

```sh
$ dsh-rec inspect examples/sample-fixture.jsonl
# deepseek-official / deepseek-v4-flash
# label: sample-conversation
# recorded: 2026-08-14T14:29:19.153Z
# calls: 2

[   0] 2026-08-14T12:00:00.000Z  fingerprint=fp-a  6 chunks
[   1] 2026-08-14T12:00:02.000Z  fingerprint=fp-b  5 chunks
```

### Diff two fixtures

```sh
$ dsh-rec diff a.jsonl b.jsonl
- missing in right: callId=...
- chunks differ at callId=... index=3: left={"type":"text-delta","delta":"hi"} right={"type":"text-delta","delta":"hello"}
```

Exit code is `0` when the fixtures are equivalent, `1` otherwise — drop it
into CI as a guard.

### Redact a fixture

```sh
$ dsh-rec redact recording.jsonl --out redacted.jsonl --hash
redacted 4 field(s) across 12 record(s); wrote redacted.jsonl
paths: extras.apiKey, extras.system
```

The redactor replaces configured paths with stable
`{ redacted: true, shape, length?, hash? }` placeholders. `--hash` adds a
12-character SHA-256 prefix so two redacted fields with the same hash
came from the same secret without ever seeing the secret. Shape and length
are always preserved so a length-based assertion still passes.

### Merge two fixtures

```sh
$ dsh-rec merge a.jsonl b.jsonl --out merged.jsonl --label session-pack
merged 7 call(s) into merged.jsonl
```

The merged header records the `recordedAt` of both source fixtures in
`meta.mergedFrom`, so the provenance is reconstructable.

## Recording into dsh

A recorder is a structural `LlmAdapter`. The dsh LLM runtime accepts any
value with a `stream(options)` method, so the recorder is registered with
`ctx.llm.registerAdapter(routes, recorder)` and the agent loop routes
matching calls through the inner adapter while mirroring them to disk.

```ts
import { RecorderAdapter, openWriter } from '@dsh-contrib/dsh-record-replay'

const writer = openWriter({
  file: 'fixtures/recording.jsonl',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  label: 'my-session',
})

const recorder = new RecorderAdapter({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  inner: deepseekAdapter, // the live `LlmAdapter` you would otherwise use
  writer,
  context: ctx,
})

const dispose = ctx.llm.registerAdapter(['deepseek-official'], recorder)
// ... run a session ...
await recorder.flush()
recorder.close()
dispose()
```

## Replaying from dsh

The replayer is also a structural `LlmAdapter`. Three matching strategies
are available:

| Strategy   | What it does                                                                  |
|------------|-------------------------------------------------------------------------------|
| `sequential` (default) | Match live calls to recorded calls in order; no content check.    |
| `exact`    | Match by request fingerprint (`sha256(provider + model + messages + extras)`).|
| `fuzzy`    | Match by the longest user-text prefix above a configurable threshold.          |

```ts
import { ReplayerAdapter } from '@dsh-contrib/dsh-record-replay'

const replayer = new ReplayerAdapter({
  file: 'fixtures/recording.jsonl',
  strategy: 'fuzzy',
  minPrefixChars: 16,
  onExhausted: 'throw',
})

const dispose = ctx.llm.registerAdapter(['deepseek-official'], replayer)
```

`onExhausted: 'hang'` keeps the stream open with no chunks until
cancellation — useful for the agent loop to detect a missing fixture
gracefully. `onExhausted: 'throw'` (default) raises; the replayer error
naming the cursor position and the model that ran out.

## Fixture format

A fixture is line-delimited JSON. Every line is a `kind`-discriminated
record. The first line is the header; subsequent lines pair
`request` and `chunks` (or `failure`) records by `callId`.

```jsonl
{"kind":"header","version":"1.0","recordedAt":"...","provider":"...","model":"...","label":"...","meta":{...}}
{"kind":"request","callId":"<uuid>","fingerprint":"<hash>","provider":"...","model":"...","messages":[...],"extras":{...},"startedAt":"..."}
{"kind":"chunks","callId":"<uuid>","chunks":[...],"endedAt":"..."}
{"kind":"failure","callId":"<uuid>","failure":{"message":"...","code":"..."},"endedAt":"..."}
```

The schema is append-only and versioned (`"version":"1.0"`). The writer
opens the file, holds the descriptor, and `fsync`s after every record so a
crash never leaves a half-written call on disk.

The `extras` field captures every `GenerateOptions` field that is not a
routing field (`provider`, `model`, `messages`, `sessionId`) or the
cancellation signal. A `system` slot, `tools` schema, `temperature`,
`maxTokens`, `stop`, `reasoningEffort`, or `purpose` survives a
record/replay round-trip without a plugin change.

## Programmatic API

The package exposes the recorder, replayer, fixture reader/writer, redact,
diff, merge, and strategy builders as named ESM entry points:

```ts
import { RecorderAdapter, ReplayerAdapter, ReplayError } from '@dsh-contrib/dsh-record-replay'
import { openWriter, readFixture, fingerprintRequest, extractExtras } from '@dsh-contrib/dsh-record-replay/fixture'
import { redactRecord, redactRecords } from '@dsh-contrib/dsh-record-replay/redact'
import { diffFixtures } from '@dsh-contrib/dsh-record-replay/diff'
import { mergeFixtures, writeMerge } from '@dsh-contrib/dsh-record-replay/merge'
import { buildStrategy, SequentialStrategy, ExactStrategy, FuzzyStrategy } from '@dsh-contrib/dsh-record-replay/strategies'
```

`dsh-rec` is a thin wrapper over the same API.

## Testing

```sh
npm install
npm run typecheck
npm test
npm run build
```

40 unit tests cover the fixture writer/reader, the recorder's pass-through
and failure paths, the replayer's sequential/exact/fuzzy strategies and
`onExhausted` modes, redactor shape/length/hash, the structural diff, and
the merge header override.

## Known Limitations and Deferred Work

- **No live integration tests** — the test suite is structural and uses a
  stub adapter; the recorder and replayer are exercised end-to-end by the
  CLI's inspect/diff/redact subcommands against a hand-written sample
  fixture. A live dsh integration test would need a real LLM key and is
  out of scope for this initial release.
- **Single-fixture replay only** — the replayer does not currently
  support nested agents with multiple `session.N.jsonl` files; the
  official `dsh-llm-replay` does. If a nested scenario arises, point the
  official adapter at the same fixture or add a `childFiles` option here.
- **Fixtures are not durable across format bumps** — `FIXTURE_VERSION` is
  `"1.0"` and will not change without a migration tool. The header is
  reserved for that.

## License

MIT. See [LICENSE](./LICENSE).

---

# 中文

`dsh-record-replay` 用来录制和回放 DeepSeek Harness(`dsh`)的 LLM 调用。
它是 `@deepseek-ai/dsh-llm-replay` 的**用户级补充**:官方 `dsh-llm-replay`
是面向 snapshot 测试的 *keyless adapter*,从 session JSONL 推导回放脚本;
而 `dsh-record-replay` 是面向**真实开发流程**的小工具,负责"录制 → 脱敏
→ diff → 合并 → 回放"这一整条链路,并提供 `dsh-rec` CLI。

## 为什么需要它

dsh 每次 `stream()` 调用都会吐出一串 `StreamChunk`。Recorder 包装任何
`LlmAdapter`,把每次请求的输入和响应流原样镜像到 JSONL;Replayer 读取
同一个 JSONL,在内存里把它当成真的 `LlmAdapter` 用 —— 所以可以直接
`ctx.llm.registerAdapter(routes, replayer)` 注册到 dsh。CLI 负责离线的
编辑/检查工具。

典型工作流:

1. **录制**:跑一次真实 session,把 LLM 调用存到 fixture
2. **脱敏**:去掉 API key、system prompt 等敏感字段后再分享
3. **回放**:本地、CI 或同事的沙箱里跑,无 key、无网络、确定性输出
4. **diff**:两个 fixture 对比,看模型或 prompt 改了之后输出变了没
5. **合并**:把多个 session fixture 拼成一个回归包

## 安装

```sh
npm install @dsh-contrib/dsh-record-replay
```

需要 `@deepseek-ai/dsh-llm`(peer dep)。Recorder / Replayer / `dsh-rec`
CLI 都能在纯净的 Node 20+ ESM 进程里跑,不需要 Cordis Loader 装载
(除非你想走 Loader 装配)。

## 快速上手

### 生成一个 fixture

```sh
node examples/generate-fixture.mjs
```

### 查看

```sh
$ dsh-rec inspect examples/sample-fixture.jsonl
# deepseek-official / deepseek-v4-flash
# label: sample-conversation
# recorded: 2026-08-14T14:29:19.153Z
# calls: 2
[   0] 2026-08-14T12:00:00.000Z  fingerprint=fp-a  6 chunks
[   1] 2026-08-14T12:00:02.000Z  fingerprint=fp-b  5 chunks
```

### Diff

```sh
$ dsh-rec diff a.jsonl b.jsonl
- missing in right: callId=...
- chunks differ at callId=... index=3: ...
```

退出码:一致 → `0`,不一致 → `1`,可以直接进 CI 卡门禁。

### 脱敏

```sh
$ dsh-rec redact recording.jsonl --out redacted.jsonl --hash
redacted 4 field(s) across 12 record(s); wrote redacted.jsonl
paths: extras.apiKey, extras.system
```

`--hash` 给每个脱敏字段加 12 位 SHA-256 前缀,**两个脱敏字段 hash 相同
就证明它们原本是同一个 secret,而不暴露 secret 本身**。shape 和 length
永远保留,长度断言照样能过。

### 合并

```sh
$ dsh-rec merge a.jsonl b.jsonl --out merged.jsonl --label session-pack
merged 7 call(s) into merged.jsonl
```

合并后的 header `meta.mergedFrom` 记录两个源 fixture 的 `recordedAt`,
provenance 可追溯。

## 接到 dsh

Recorder 是结构化的 `LlmAdapter`,dsh 的 `ctx.llm.registerAdapter(routes,
adapter)` 接受任何带 `stream(options)` 方法的对象 —— 所以包装一下就
能直接注册,agent loop 走 inner adapter 真实发请求,Recorder 在中间
镜像到磁盘。

```ts
import { RecorderAdapter, openWriter } from '@dsh-contrib/dsh-record-replay'

const writer = openWriter({
  file: 'fixtures/recording.jsonl',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  label: 'my-session',
})

const recorder = new RecorderAdapter({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  inner: deepseekAdapter,
  writer,
  context: ctx,
})

const dispose = ctx.llm.registerAdapter(['deepseek-official'], recorder)
// ... 跑 session ...
await recorder.flush()
recorder.close()
dispose()
```

## 用 Replayer 跑回放

Replayer 也是结构化的 `LlmAdapter`,三种匹配策略:

| 策略                | 行为                                                                                |
|---------------------|-------------------------------------------------------------------------------------|
| `sequential`(默认)  | 按录制顺序消费,不校验内容。                                                        |
| `exact`             | 按 `sha256(provider + model + messages + extras)` 的 fingerprint 匹配。            |
| `fuzzy`             | 按用户文本前缀(超过配置阈值)匹配。                                                 |

```ts
import { ReplayerAdapter } from '@dsh-contrib/dsh-record-replay'

const replayer = new ReplayerAdapter({
  file: 'fixtures/recording.jsonl',
  strategy: 'fuzzy',
  minPrefixChars: 16,
  onExhausted: 'throw',
})

const dispose = ctx.llm.registerAdapter(['deepseek-official'], replayer)
```

`onExhausted: 'hang'` 让 stream 一直挂着不返回,等外层 cancel —— 给
agent loop 一个"我跑完了,但 fixture 用完了"的信号;
`onExhausted: 'throw'`(默认)直接抛错,错误里带 cursor 位置和 model。

## Fixture 格式

一行一个 JSON 记录,每个记录有 `kind` 判别字段。第一行是 header,后面
`request` 和 `chunks`(或 `failure`)按 `callId` 配对出现。

```jsonl
{"kind":"header","version":"1.0","recordedAt":"...","provider":"...","model":"...","label":"...","meta":{...}}
{"kind":"request","callId":"<uuid>","fingerprint":"<hash>","provider":"...","model":"...","messages":[...],"extras":{...},"startedAt":"..."}
{"kind":"chunks","callId":"<uuid>","chunks":[...],"endedAt":"..."}
{"kind":"failure","callId":"<uuid>","failure":{"message":"...","code":"..."},"endedAt":"..."}
```

只追加,带版本号(`"version":"1.0"`)。Writer 打开文件后持有 fd,每条
记录后 `fsync` —— 进程崩溃也不会留下半行。

`extras` 字段捕获 `GenerateOptions` 里所有**非路由字段**
(`provider`、`model`、`messages`、`sessionId`)和取消信号以外的字段,
所以 `system` slot、`tools` schema、`temperature`、`maxTokens`、`stop`、
`reasoningEffort`、`purpose` 都能 round-trip 不用改插件。

## 编程接口

包导出 Recorder、Replayer、fixture 读写、redact、diff、merge、strategy
构建器作为命名的 ESM 入口点:

```ts
import { RecorderAdapter, ReplayerAdapter, ReplayError } from '@dsh-contrib/dsh-record-replay'
import { openWriter, readFixture, fingerprintRequest, extractExtras } from '@dsh-contrib/dsh-record-replay/fixture'
import { redactRecord, redactRecords } from '@dsh-contrib/dsh-record-replay/redact'
import { diffFixtures } from '@dsh-contrib/dsh-record-replay/diff'
import { mergeFixtures, writeMerge } from '@dsh-contrib/dsh-record-replay/merge'
import { buildStrategy, SequentialStrategy, ExactStrategy, FuzzyStrategy } from '@dsh-contrib/dsh-record-replay/strategies'
```

`dsh-rec` CLI 是同一套 API 的薄壳。

## 测试

```sh
npm install
npm run typecheck
npm test
npm run build
```

40 个单测覆盖:fixture 读写、Recorder 透传和失败路径、Replayer 三种
策略和 `onExhausted` 模式、Redactor 的 shape/length/hash、结构化 diff、
merge header override。

## 已知限制 / 推迟的工作

- **没有 live 集成测试** — 测试套件是结构化的,用 stub adapter。
  Recorder 和 Replayer 的端到端验证靠 CLI 自己的 inspect / diff /
  redact 子命令对样例 fixture 跑。Live dsh 集成测试需要真 LLM
  key,不在本版本范围。
- **单 fixture 回放** — 暂不支持嵌套 agent 的多 `session.N.jsonl`
  (官方 `dsh-llm-replay` 支持)。如果出现嵌套场景,让官方 adapter
  指向同一个 fixture,或者在这里加一个 `childFiles` 选项。
- **Fixture 格式不跨版本兼容** — `FIXTURE_VERSION = "1.0"`,除非有
  迁移工具,否则不会改。Header 字段为迁移预留。

## 协议

MIT。
