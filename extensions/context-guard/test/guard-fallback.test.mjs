import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";
import contextGuard, { truncateUtf8 } from "../index.ts";

const TOOL = "mem_session_summary";
const dirs = [];

function scratch(prefix = "guard-fallback-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CONTEXT_GUARD_CONFIG;
  delete process.env.CONTEXT_GUARD_DISABLED;
  delete process.env.ENGRAM_DATA_DIR;
  delete process.env.ENGRAM_BIN;
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function setup({ saver, hasUI = true, sessionId = "session-1", useDefaultSaver = false } = {}) {
  process.env.CONTEXT_GUARD_CONFIG = join(scratch(), "none.json");
  const fake = createFakePi({ activeTools: [TOOL] });
  const emits = [];
  fake.pi.events.on("context-guard", (data) => emits.push(data));
  const requests = [];
  const saveToEngram = saver ?? (async (request) => { requests.push(request); });
  contextGuard(fake.pi, useDefaultSaver ? {} : { saveToEngram });
  const ctx = createFakeCtx({ hasUI, sessionId, usage: { tokens: 120000, contextWindow: 200000, percent: null } });
  const compact = (summary, reason = "manual", id = undefined) =>
    fake.fire("session_compact", { compactionEntry: { id, summary, tokensBefore: 120000 }, fromExtension: false, reason, willRetry: false }, ctx);
  async function guardCompaction({ save, summary = "Pi summary" }) {
    await fake.fire("agent_before_settle", { context: { canContinue: false } }, ctx);
    if (save) await fake.fire("tool_execution_end", { toolCallId: "t", toolName: TOOL, result: textResult("ok"), isError: false }, ctx);
    await fake.fire("agent_settled", { aborted: false }, ctx);
    // Pi emits session_compact before calling onComplete.
    await compact(summary, "manual");
    ctx.compactCalls.at(-1).onComplete({});
  }
  return { ...fake, ctx, emits, requests, compact, guardCompaction, events: () => emits.map((e) => e.event) };
}

test("a guard compaction without a save stores Pi's summary once with a unique topic", async () => {
  const s = setup({ sessionId: "abc" });
  await s.guardCompaction({ save: false, summary: "Goal: ship <private>token=123</private> the guard <PRIVATE>x\ny</Private> done" });
  assert.equal(s.requests.length, 1);
  const [request] = s.requests;
  assert.equal(request.topic, "session/abc/compaction-1");
  assert.equal(request.type, "session_summary");
  assert.equal(request.scope, "project");
  assert.equal(request.title, "Context guard fallback summary (compaction 1)");
  assert.equal(request.cwd, "/tmp/project-a");
  assert.equal(
    request.content,
    "The model did not save a session summary before this compaction (reason manual); this is Pi's compaction summary.\n\n" +
      "Goal: ship [REDACTED] the guard [REDACTED] done",
  );
  assert.deepEqual(s.events(), ["save_requested", "compact_requested", "fallback_saved", "compact_done"]);
  assert.equal(s.emits[2].reason, "manual");
});

test("an observed save needs no fallback", async () => {
  const s = setup();
  await s.guardCompaction({ save: true });
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.events(), ["save_requested", "save_done", "compact_requested", "compact_done"]);
});

test("Pi's own threshold compaction while the guard is idle falls back with that reason", async () => {
  const s = setup();
  await s.compact("Pi summary", "threshold");
  assert.equal(s.requests.length, 1);
  assert.match(s.requests[0].content, /\(reason threshold\)/);
  assert.deepEqual(s.emits.map(({ event, reason }) => ({ event, reason })), [{ event: "fallback_saved", reason: "threshold" }]);
});

test("the compaction counter increments per compaction and resets on session_start", async () => {
  const s = setup({ sessionId: "abc" });
  await s.guardCompaction({ save: true });
  await s.compact("second", "overflow");
  await s.compact("third", "manual");
  assert.deepEqual(s.requests.map((r) => r.topic), ["session/abc/compaction-2", "session/abc/compaction-3"]);
  assert.equal(s.requests[1].title, "Context guard fallback summary (compaction 3)");
  await s.fire("session_start", { reason: "new" }, s.ctx);
  await s.compact("after restart", "threshold");
  assert.equal(s.requests.at(-1).topic, "session/abc/compaction-1");
});

test("a resumed session never reuses a fallback topic: Pi's compaction entry id keys it", async () => {
  const s = setup({ sessionId: "abc" });
  await s.compact("first", "threshold", "e1f2a3b4");
  await s.fire("session_start", { reason: "resume" }, s.ctx);
  await s.compact("after resume", "threshold", "c9d8e7f6");
  assert.deepEqual(s.requests.map((r) => r.topic), ["session/abc/compaction-e1f2a3b4", "session/abc/compaction-c9d8e7f6"]);
  assert.deepEqual(s.requests.map((r) => r.title), ["Context guard fallback summary (compaction 1)", "Context guard fallback summary (compaction 1)"]);
});

test("no fallback without UI", async () => {
  const s = setup({ hasUI: false });
  await s.compact("Pi summary", "threshold");
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.emits, []);
});

test("no fallback with the kill switch", async () => {
  process.env.CONTEXT_GUARD_DISABLED = "1";
  const s = setup();
  await s.compact("Pi summary", "threshold");
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.emits, []);
});

test("an empty or missing summary reports no_summary without calling the saver", async () => {
  const s = setup();
  await s.compact("   ", "threshold");
  await s.fire("session_compact", { reason: "overflow" }, s.ctx);
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.emits.map(({ event, reason }) => ({ event, reason })), [
    { event: "fallback_failed", reason: "no_summary" },
    { event: "fallback_failed", reason: "no_summary" },
  ]);
});

for (const [label, error, reason] of [
  ["a missing binary", Object.assign(new Error("spawn engram ENOENT secret-path"), { code: "ENOENT" }), "unavailable"],
  ["a killed process", Object.assign(new Error("killed secret-path"), { killed: true, signal: "SIGTERM", code: null }), "timeout"],
  ["any other failure", Object.assign(new Error("exit 1 secret-path"), { code: 1, stderr: "secret-path" }), "error"],
]) {
  test(`${label} is reported as ${reason} without error text on the bus`, async () => {
    const s = setup({ saver: async () => { throw error; } });
    await s.guardCompaction({ save: false });
    assert.deepEqual(s.events(), ["save_requested", "compact_requested", "fallback_failed", "compact_done"]);
    assert.equal(s.emits[2].reason, reason);
    assert.ok(!JSON.stringify(s.emits).includes("secret-path"));
  });
}

test("a large multi-byte summary is truncated below 100000 UTF-8 bytes without splitting characters", async () => {
  const s = setup();
  await s.compact("é漢😀".repeat(20000), "threshold");
  const { content } = s.requests[0];
  const bytes = Buffer.byteLength(content, "utf8");
  assert.ok(bytes < 100000, `${bytes} bytes`);
  assert.ok(bytes > 99000, `${bytes} bytes`);
  assert.ok(!content.includes("\uFFFD"));
  assert.ok(content.endsWith("[truncated]"));
});

test("truncateUtf8 keeps short text and never splits a code point", () => {
  assert.equal(truncateUtf8("abc", 10), "abc");
  assert.equal(truncateUtf8("aé", 2), "a");
  assert.equal(truncateUtf8("a😀b", 4), "a");
  assert.equal(truncateUtf8("a😀b", 5), "a😀");
});

test("the default saver stores the summary with the real engram CLI", async (t) => {
  try {
    execFileSync("engram", ["version"], { stdio: "ignore" });
  } catch {
    t.skip("engram is not on PATH");
    return;
  }
  process.env.ENGRAM_DATA_DIR = scratch("guard-fallback-store-");
  const s = setup({ sessionId: "itest", useDefaultSaver: true });
  s.ctx.cwd = scratch("guard-fallback-cwd-");
  await s.compact("Integration summary qx7fallbackmarker", "threshold");
  assert.deepEqual(s.events(), ["fallback_saved"]);
  const found = execFileSync("engram", ["search", "qx7fallbackmarker", "--all"], { cwd: s.ctx.cwd, encoding: "utf8" });
  assert.match(found, /Context guard fallback summary \(compaction 1\)/);
});

test("the default saver reports a missing binary as unavailable", async () => {
  process.env.ENGRAM_BIN = join(scratch(), "missing-engram");
  const s = setup({ useDefaultSaver: true });
  await s.compact("Pi summary", "threshold");
  assert.deepEqual(s.emits.map(({ event, reason }) => ({ event, reason })), [{ event: "fallback_failed", reason: "unavailable" }]);
});
