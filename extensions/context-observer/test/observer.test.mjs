import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";
import contextObserver, { summarize, formatReport } from "../index.ts";

function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "context-observer-"));
  const file = join(dir, "metrics.jsonl");
  process.env.CONTEXT_METRICS_FILE = file;
  const fake = createFakePi();
  contextObserver(fake.pi);
  const ctx = createFakeCtx(options);
  const records = () =>
    existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
  return { ...fake, ctx, file, records, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function readTool(s, id, path, text = "file body") {
  await s.fire("tool_execution_start", { toolCallId: id, toolName: "read", args: { path } }, s.ctx);
  await s.fire("tool_execution_end", { toolCallId: id, toolName: "read", result: textResult(text), isError: false }, s.ctx);
}

async function compaction(s, reason = "threshold", tokensBefore = 120000) {
  await s.fire("session_before_compact", { reason, preparation: { tokensBefore }, willRetry: false }, s.ctx);
  await s.fire("session_compact", { reason, compactionEntry: { tokensBefore, summary: "secret summary" }, fromExtension: false, willRetry: false }, s.ctx);
}

test("turn_end records model, tokens, window and percent", async () => {
  const s = setup({ usage: { tokens: 50000, contextWindow: 200000, percent: 25 } });
  try {
    await s.fire("turn_end", { turnIndex: 3, message: { content: "private answer" } }, s.ctx);
    const [record] = s.records();
    assert.equal(record.kind, "turn");
    assert.equal(record.model, "anthropic/claude-test");
    assert.equal(record.tokens, 50000);
    assert.equal(record.window, 200000);
    assert.equal(record.percent, 25);
    assert.equal(record.session, "session-1");
    assert.equal(record.turnsSinceCompaction, null);
    assert.doesNotMatch(readFileSync(s.file, "utf8"), /private answer/);
  } finally {
    s.cleanup();
  }
});

test("compaction success and failure are recorded without the summary text", async () => {
  const s = setup();
  try {
    await compaction(s, "threshold", 120000);
    await s.fire("session_before_compact", { reason: "manual", preparation: { tokensBefore: 90000 }, willRetry: false }, s.ctx);
    await s.fire("session_compact_failed", { reason: "manual", errorMessage: "boom", aborted: false, willRetry: false, fromExtension: false }, s.ctx);
    const [ok, failed] = s.records();
    assert.equal(ok.kind, "compaction");
    assert.equal(ok.ok, true);
    assert.equal(ok.reason, "threshold");
    assert.equal(ok.tokensBefore, 120000);
    assert.equal(typeof ok.durationMs, "number");
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "manual");
    assert.equal(failed.tokensBefore, 90000);
    assert.doesNotMatch(readFileSync(s.file, "utf8"), /secret summary|boom/);
  } finally {
    s.cleanup();
  }
});

test("turns after a compaction carry turnsSinceCompaction", async () => {
  const s = setup();
  try {
    await compaction(s);
    await s.fire("turn_end", { turnIndex: 0 }, s.ctx);
    await s.fire("turn_end", { turnIndex: 1 }, s.ctx);
    const turns = s.records().filter((r) => r.kind === "turn");
    assert.deepEqual(turns.map((r) => r.turnsSinceCompaction), [1, 2]);
  } finally {
    s.cleanup();
  }
});

test("failed edits and other tool errors are recorded by tool name only", async () => {
  const s = setup();
  try {
    await s.fire("tool_execution_start", { toolCallId: "e1", toolName: "edit", args: { path: "a.ts" } }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "e1", toolName: "edit", result: textResult("oldText not found"), isError: true }, s.ctx);
    await s.fire("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: { command: "ls" } }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: textResult("permission denied"), isError: true }, s.ctx);
    await s.fire("tool_execution_start", { toolCallId: "b2", toolName: "bash", args: { command: "ls" } }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "b2", toolName: "bash", result: textResult("ok"), isError: false }, s.ctx);
    const records = s.records();
    assert.deepEqual(records.map((r) => [r.kind, r.tool]), [["edit_failure", "edit"], ["tool_error", "bash"]]);
    assert.doesNotMatch(readFileSync(s.file, "utf8"), /oldText not found|permission denied|a\.ts/);
  } finally {
    s.cleanup();
  }
});

test("re-reading a file seen before the last compaction is recorded once, without the path", async () => {
  const s = setup();
  try {
    await readTool(s, "r1", "src/known.ts");
    await compaction(s);
    await readTool(s, "r2", "src/known.ts");
    await readTool(s, "r3", "src/new.ts");
    await readTool(s, "r4", "src/known.ts");
    const rereads = s.records().filter((r) => r.kind === "reread_after_compaction");
    assert.equal(rereads.length, 1);
    assert.equal(rereads[0].turnsSinceCompaction, 0);
    assert.doesNotMatch(readFileSync(s.file, "utf8"), /known\.ts|new\.ts/);
  } finally {
    s.cleanup();
  }
});

test("memory lookups after a compaction record whether they came back empty", async () => {
  const s = setup();
  try {
    await s.fire("tool_execution_start", { toolCallId: "m0", toolName: "mem_search", args: { query: "before" } }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "m0", toolName: "mem_search", result: textResult("hit"), isError: false }, s.ctx);
    await compaction(s);
    await s.fire("tool_execution_start", { toolCallId: "m1", toolName: "mem_search", args: { query: "auth flow" } }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "m1", toolName: "mem_search", result: textResult("No memories found for that query."), isError: false }, s.ctx);
    await s.fire("tool_execution_start", { toolCallId: "m2", toolName: "mem_context", args: {} }, s.ctx);
    await s.fire("tool_execution_end", { toolCallId: "m2", toolName: "mem_context", result: textResult("## Recent sessions\n- decided to use JWT"), isError: false }, s.ctx);
    const lookups = s.records().filter((r) => r.kind === "memory_lookup");
    assert.deepEqual(lookups.map((r) => [r.tool, r.empty, r.afterCompaction]), [
      ["mem_search", false, false],
      ["mem_search", true, true],
      ["mem_context", false, true],
    ]);
    assert.doesNotMatch(readFileSync(s.file, "utf8"), /auth flow|JWT/);
  } finally {
    s.cleanup();
  }
});

test("guard events on the event bus are recorded with whitelisted fields only", async () => {
  const s = setup();
  try {
    await s.fire("session_start", { reason: "startup" }, s.ctx);
    s.pi.events.emit("context-guard", { event: "save_requested", tokens: 100000, threshold: 100000, window: 200000, model: "anthropic/claude-test", summary: "leak" });
    const guard = s.records().find((r) => r.kind === "guard");
    assert.equal(guard.event, "save_requested");
    assert.equal(guard.threshold, 100000);
    assert.equal(guard.session, "session-1");
    assert.equal(guard.summary, undefined);
  } finally {
    s.cleanup();
  }
});

async function withChildEnv(value, fn) {
  const previous = process.env.GENTLE_PI_AGENTS_CHILD;
  if (value === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
  else process.env.GENTLE_PI_AGENTS_CHILD = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
    else process.env.GENTLE_PI_AGENTS_CHILD = previous;
  }
}

test("records from a Gentle Shell subagent session carry child: true", async () => {
  await withChildEnv("1", async () => {
    const s = setup();
    try {
      await s.fire("session_start", { reason: "startup" }, s.ctx);
      await s.fire("turn_end", { turnIndex: 0 }, s.ctx);
      await compaction(s);
      s.pi.events.emit("context-guard", { event: "fallback_saved", reason: "threshold" });
      await s.runCommand("context-flag", "", s.ctx);
      const records = s.records();
      assert.deepEqual(records.map((r) => r.kind), ["turn", "compaction", "guard", "flag"]);
      for (const record of records) assert.equal(record.child, true, record.kind);
    } finally {
      s.cleanup();
    }
  });
});

test("records from a primary session have no child field", async () => {
  for (const value of [undefined, "", "0", "true"]) {
    await withChildEnv(value, async () => {
      const s = setup();
      try {
        await s.fire("turn_end", { turnIndex: 0 }, s.ctx);
        await compaction(s);
        for (const record of s.records()) assert.equal("child" in record, false, `${value} ${record.kind}`);
      } finally {
        s.cleanup();
      }
    });
  }
});

test("summarize and /context-report split subagent sessions from primary ones", async () => {
  const model = "m/x";
  const records = [
    { kind: "turn", model, session: "p1", tokens: 1000, window: 100000 },
    { kind: "turn", model, session: "p1", tokens: 3000, window: 100000 },
    { kind: "turn", model, session: "c1", child: true, tokens: 90000, window: 100000 },
    { kind: "compaction", model, session: "c1", child: true, ok: true, reason: "threshold", tokensBefore: 95000, durationMs: 1000 },
  ];
  const summaries = summarize(records);
  assert.deepEqual(summaries.map((s) => [s.model, s.subagent, s.sessions, s.turns, s.maxTokens, s.compactions.total]), [
    [model, false, 1, 2, 3000, 0],
    [model, true, 1, 1, 90000, 1],
  ]);
  const report = formatReport(summaries);
  assert.match(report, /^m\/x \(sessions: 1, turns: 2,/m);
  assert.match(report, /^m\/x, subagents \(sessions: 1, turns: 1,/m);
});

test("sessions without UI (print and json modes) record nothing", async () => {
  const s = setup({ hasUI: false });
  try {
    await s.fire("turn_end", { turnIndex: 0 }, s.ctx);
    await compaction(s);
    assert.deepEqual(s.records(), []);
  } finally {
    s.cleanup();
  }
});

test("/context-flag records the moment with current usage", async () => {
  const s = setup({ usage: { tokens: 140000, contextWindow: 200000, percent: 70 } });
  try {
    await s.runCommand("context-flag", "", s.ctx);
    const [flag] = s.records();
    assert.equal(flag.kind, "flag");
    assert.equal(flag.tokens, 140000);
    assert.equal(flag.model, "anthropic/claude-test");
    assert.equal(s.ctx.notifications.length, 1);
  } finally {
    s.cleanup();
  }
});

test("/context-report notifies a per-model summary", async () => {
  const s = setup({ usage: { tokens: 80000, contextWindow: 200000, percent: 40 } });
  try {
    await s.fire("turn_end", { turnIndex: 0 }, s.ctx);
    await compaction(s, "threshold", 100000);
    await s.runCommand("context-flag", "", s.ctx);
    s.ctx.notifications.length = 0;
    await s.runCommand("context-report", "", s.ctx);
    const [[message, level]] = s.ctx.notifications;
    assert.equal(level, "info");
    assert.match(message, /anthropic\/claude-test/);
    assert.match(message, /Compactions: 1/);
    assert.match(message, /Flags: 1/);
  } finally {
    s.cleanup();
  }
});

test("/context-report says so when there is no data yet", async () => {
  const s = setup();
  try {
    await s.runCommand("context-report", "", s.ctx);
    assert.match(s.ctx.notifications[0][0], /No context metrics recorded yet/);
  } finally {
    s.cleanup();
  }
});

test("summarize splits error rates after compaction from the rest", () => {
  const model = "m/x";
  const records = [
    ...Array.from({ length: 10 }, (_, i) => ({ kind: "turn", model, tokens: 1000 * (i + 1), window: 100000, turnsSinceCompaction: i < 5 ? null : i - 4 })),
    { kind: "compaction", model, ok: true, reason: "manual", tokensBefore: 50000, durationMs: 2000 },
    { kind: "compaction", model, ok: false, reason: "threshold", tokensBefore: 60000, durationMs: 100 },
    { kind: "edit_failure", model, tool: "edit", turnsSinceCompaction: 1 },
    { kind: "tool_error", model, tool: "bash", turnsSinceCompaction: null },
    { kind: "reread_after_compaction", model, turnsSinceCompaction: 0 },
    { kind: "memory_lookup", model, tool: "mem_search", empty: true, afterCompaction: true },
    { kind: "guard", model, event: "save_requested" },
    { kind: "guard", model, event: "save_done" },
  ];
  const [summary] = summarize(records);
  assert.equal(summary.model, model);
  assert.equal(summary.turns, 10);
  assert.equal(summary.maxTokens, 10000);
  assert.deepEqual(summary.compactions, { total: 2, failed: 1, byReason: { manual: 1, threshold: 1 }, medianTokensBefore: 55000, medianDurationMs: 1050 });
  assert.equal(summary.errors.afterCompaction, 1);
  assert.equal(summary.errors.otherwise, 1);
  assert.equal(summary.rereadsAfterCompaction, 1);
  assert.deepEqual(summary.memoryLookupsAfterCompaction, { total: 1, empty: 1 });
  assert.deepEqual(summary.guard, { save_requested: 1, save_done: 1 });
  assert.match(formatReport([summary]), /m\/x/);
});
