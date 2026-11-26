# Changelog

## [Unreleased]

### Added

- `context-observer`: records from Gentle Shell subagent sessions (`GENTLE_PI_AGENTS_CHILD=1`) carry `"child": true`, and `/context-report` shows them apart from primary sessions on the same model.

## [0.1.0] - 2026-11-22

### Added

- `context-guard`: compacts at `max(min(ratio × window, capTokens), floorMultiplier × keepRecentTokens)` when the agent settles, after asking the model once to save a structured summary with `mem_session_summary`.
- `context-guard`: fallback save of Pi's compaction summary with `engram save` when no summary save was observed, including Pi-own and manual compactions.
- `context-observer`: content-free context and compaction metrics in `context-metrics/metrics.jsonl`, with `/context-report` and `/context-flag`.
