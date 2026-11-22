# Threshold decision

Status: accepted (2026-10-29). The values are a starting point to tune with `context-observer` data, not an established truth.

## Context

The goal is to keep the model sharp in long sessions. The first idea was to compact at 40% of the context window for every model.

What the research shows:

- **Degradation depends on the number of tokens, not on the share of the window.** Chroma measured 18 models, and performance drops as the input grows, even on simple tasks (https://www.trychroma.com/research/context-rot). NoLiMa shows strong drops from tens of thousands of tokens in models that advertise 128K to 1M windows (https://arxiv.org/abs/2502.05167).
- **Reference thresholds:**
  - Anthropic's API compacts by default at 150K input tokens, with a 50K minimum (https://platform.claude.com/docs/en/build-with-claude/compaction-threshold).
  - Bud ContextCompact 2.0 improved long SWE-bench sessions from 41% to 53% by compacting at about 50% of the input budget, on windows of about 50K (https://arxiv.org/html/2610.25516). It is a preprint with small samples, and its threshold study is not statistically significant.
  - WorkOS proposes 256K for Pi, presented as an unmeasured hypothesis (https://workos.com/blog/coding-agent-context-window-compaction-settings).
- **Pi compacts only on free tokens:** `contextTokens > contextWindow - reserveTokens`, with `reserveTokens` 16384 by default. With a 1M window that is about 984K, too late.
- **`ctx.compact()` interrupts the running turn**, so compaction must wait until the agent settles.
- **Engram does not replace the context window:** what is recalled comes back into the context. It helps because it brings back only what is relevant.

## Decision

Compact at `min(50% of the window, 150K tokens)`, with a floor of `2 × keepRecentTokens`. When that value does not fit below `window - reserveTokens` (for example a 50K window), Pi's own compaction applies.

Before compacting, ask the model once to save a structured summary with `mem_session_summary`. Compact only at `agent_settled`. If no save was observed, save Pi's compaction summary with `engram save`.

Record content-free metrics with a separate observer that also works without the guard, to get a baseline.

## Consequences

- **Gains:** a threshold that makes sense for every model (the percentage rules on small windows, the cap on large ones); the session is saved before and after compacting; data to tune the values.
- **Costs:** one model call and one extra turn per compaction; the prompt cache is lost; chained summaries can accumulate errors.
- **Watch:** if the report shows high peak tokens per turn, compaction is also needed mid-run. If Engram searches after compaction are often empty, the summary is not helping.
