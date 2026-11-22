# pi-context-guard

Two [Pi](https://pi.dev) extensions for long coding sessions:

- **`context-guard`** compacts the session at a model-independent threshold, and asks the model to save a structured session summary to [Engram](https://github.com/Gentleman-Programming/engram) first.
- **`context-observer`** records context and compaction metrics (never conversation content), so you can tune the threshold with your own data instead of guesses.

Without an active `mem_session_summary` tool (for example from [gentle-engram](https://www.npmjs.com/package/gentle-engram)), the guard neither asks for a save nor compacts. The observer works on its own.

Community package, not affiliated with Gentleman Programming. Compatible with Gentle Shell and gentle-engram.

## Why compact earlier

By default Pi compacts only when free tokens run out (`contextTokens > contextWindow - reserveTokens`, with `reserveTokens` 16384). With a 1M window that is around 984K tokens, long after the model started losing precision.

- **A bigger window does not mean the same quality across it.** Degradation depends on how many tokens are in context, not on the share of the window in use. Chroma measured 18 models and all of them got worse as the input grew, even on simple tasks ([Context Rot](https://www.trychroma.com/research/context-rot)).
- **The drop starts early.** NoLiMa found strong drops from tens of thousands of tokens on models that advertise windows from 128K to 1M ([arXiv:2502.05167](https://arxiv.org/abs/2502.05167)).
- **150K is a known default.** The Anthropic API compacts at 150K input tokens by default ([compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)). The guard uses the same cap.
- **Save before you compact.** Every compaction loses detail. When the model writes its own structured summary while it still sees everything, and that summary lives in Engram, a later session can search it and bring back only what matters.

The costs, honestly: one extra model call per compaction, a lost prompt cache, and chained summaries that can accumulate errors. The defaults are a starting point, which is why `context-observer` exists. See [docs/threshold.md](docs/threshold.md) for the reasoning and the sources.

## How it works

`context-guard` uses this threshold:

```
threshold = max(min(ratio × window, capTokens), floorMultiplier × keepRecentTokens)
```

The defaults are `ratio` 0.5, `capTokens` 150000 and `floorMultiplier` 2. The percentage rules on small windows, the cap rules on large ones. When the threshold does not fit below `window - reserveTokens`, the guard does nothing and Pi's own compaction applies.

With Pi's defaults (`keepRecentTokens` 20000, `reserveTokens` 16384):

| Window | Guard compacts at | Pi alone compacts at |
| --- | --- | --- |
| 1M | 150K | ~984K |
| 400K | 150K | ~384K |
| 200K | 100K | ~184K |
| 128K | 64K | ~112K |
| 64K | 40K (floor) | ~48K |
| 50K or less | does nothing | Pi's own threshold |

When a run ends above the threshold:

1. **Save.** The guard adds one message asking the model to call `mem_session_summary` with the sections Goal, Instructions, Discoveries, Accomplished, Next Steps and Relevant Files. It asks once per threshold crossing.
2. **Compact.** When the agent is idle (`agent_settled`), the guard calls `ctx.compact()`. It never compacts in the middle of a run, because that would abort it.
3. **Fallback.** When a compaction finishes without an observed `mem_session_summary` call, the guard saves Pi's compaction summary itself with `engram save`. This also covers compactions the guard did not start: Pi's own threshold or overflow compactions and manual `/compact`. Each record gets a unique topic, `session/<sessionId>/compaction-<entryId>`, so earlier summaries are never overwritten. `<private>…</private>` blocks are redacted.

After a compaction, the first token reading is a baseline. If the compacted context is still near the threshold, the guard waits until it grows by `keepRecentTokens` before compacting again. After a failed compaction it waits 3 settles before retrying.

The guard skips a settle when the usage is unknown, the run was aborted, or user messages are queued. It also skips while Pi could not compact yet: Pi keeps the newest `keepRecentTokens` of conversation and refuses with "Nothing to compact" when nothing besides the first message would be left to summarize. This happens when the system prompt alone fills most of the threshold, so the guard waits until the conversation since the last compaction (without system messages, at about 4 characters per token) exceeds `keepRecentTokens` after its first message. It asks for a save and compacts only in sessions with a UI where `mem_session_summary` is an active tool. The fallback needs a UI session but not the tool.

Pi reports a UI (`ctx.hasUI`) in TUI and RPC sessions, not in print (`-p`) or JSON mode. In print and JSON mode neither extension does anything.

## Requirements

- **Pi 1.1.0 or later.** `agent_before_settle` arrived in Pi 0.87.0, and the `aborted` field of `agent_settled` in 1.1.0. Built against Pi 1.4.0 and tested live in a real session; the API it uses was checked against Pi 1.6.0.
- **[gentle-engram](https://www.npmjs.com/package/gentle-engram)** or another extension that exposes a `mem_session_summary` tool. Without it, the guard does not ask for a save or compact on its own.
- **The `engram` CLI** on `PATH`, or its path in `ENGRAM_BIN`, for the fallback save. If it is missing, the fallback fails without blocking the compaction and emits `fallback_failed`.

`context-observer` has no requirements and works without the guard, which gives you a baseline.

## Install

From npm:

```bash
pi install npm:pi-context-guard
```

From git:

```bash
pi install git:github.com/mata-2p/pi-context-guard
```

From a local checkout:

```bash
pi install ./pi-context-guard
```

Then run `/reload` or restart Pi.

## Configure

`context-guard` reads `context-guard.json` from the Pi agent directory (`$PI_CODING_AGENT_DIR`, by default `~/.pi/agent`; in Gentle Shell `~/.gentle-shell/agent`), or the file in `CONTEXT_GUARD_CONFIG`. All fields are optional:

```json
{ "enabled": true, "ratio": 0.5, "capTokens": 150000, "floorMultiplier": 2 }
```

An invalid file falls back to the defaults and shows one warning.

To turn the guard off without uninstalling it, set `CONTEXT_GUARD_DISABLED=1` or `"enabled": false`.

`keepRecentTokens` and `reserveTokens` come from Pi's `compaction` settings, including per-model `compaction.modelOverrides`.

## Observe and tune

`context-observer` appends one JSON line per event to `<agent dir>/context-metrics/metrics.jsonl`, or to the file in `CONTEXT_METRICS_FILE`. It records:

- token usage per turn;
- compactions: reason, tokens before, duration, success or failure;
- tool errors and failed edits;
- files read again after a compaction;
- Engram searches after a compaction, and whether they returned results;
- guard events: `save_requested`, `save_done`, `compact_requested`, `compact_done`, `compact_skipped`, `compact_failed`, `fallback_saved`, `fallback_failed`.

It never records prompts, replies, tool arguments or file contents.

It adds two commands:

- `/context-report` summarizes the metrics per model.
- `/context-flag` records the moment you noticed the model lost track, with the current context usage.

The defaults are a starting point. If your flags cluster at some token count, or Engram searches after compaction often come back empty, adjust `ratio` and `capTokens`.

## Known limits

- The guard compacts only when the agent settles. A long autonomous run can pass the threshold until it ends; Pi's own `reserveTokens` compaction still protects against overflow.
- Each guarded compaction costs one extra model turn for the save, and the prompt cache is lost after compacting.
- Subagents get the guard only if they run with a UI. Gentle Shell runs each subagent as a separate `pi --mode rpc` process, so both extensions load there with a UI. None of the subagents Gentle Shell installs has `mem_session_summary` in its tool list, though. The guard therefore never asks them to save or compacts them; only the fallback saves their Pi-own compactions. A subagent run with `pi -p` or `--mode json` gets neither. A subagent also usually runs its whole task as one run and settles only at the end, so settle-time compaction would rarely help it anyway.
- When gentle-engram also archives Pi's compaction summary, a Pi-own compaction can produce two Engram records. This is by design.
- The observer's empty-search detector is a text heuristic. A result whose text contains "not found" (or "no results", "0 matches" and similar) counts as empty, even when it also lists matches.

## Development

Tests use Node's built-in runner with native TypeScript type stripping (Node 22.18 or later):

```bash
npm test
```

The tests drive the handlers through a small fake of the Pi extension API in `test-support/fake-pi.mjs`.

## License

MIT
