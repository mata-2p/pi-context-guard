// The guard must not ask for a save when Pi would refuse the compaction.
// Pi keeps the newest keepRecentTokens of conversation and summarizes only
// what comes before it; system messages are never summarized. When the
// context is large because of the system prompt, Pi throws
// "Nothing to compact (session too small)" (agent-session.js, prepareCompaction).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextGuard, { canCompact } from "../index.ts";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";

const TOOL = "mem_session_summary";
const KEEP_RECENT = 20000; // Pi's default keepRecentTokens
let dir;

afterEach(() => {
  delete process.env.CONTEXT_GUARD_CONFIG;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const chars = (tokens) => "x".repeat(tokens * 4);
const msg = (role, tokens) => ({ type: "message", message: { role, content: [{ type: "text", text: chars(tokens) }] } });
const system = (tokens) => ({ type: "message", message: { role: "system", content: chars(tokens) } });

// Shape of the live session that failed: a 38.7k-token system message and
// about 19k tokens of conversation, below keepRecentTokens.
const tooSmall = [{ type: "model_change" }, system(38685), msg("user", 68), msg("assistant", 140), msg("toolResult", 9000), msg("assistant", 100), msg("user", 50), msg("toolResult", 9500), msg("assistant", 100)];
const bigEnough = [...tooSmall, msg("user", 50), msg("toolResult", 2000), msg("assistant", 100)];

function setup(branch) {
  dir = mkdtempSync(join(tmpdir(), "guard-compactable-"));
  process.env.CONTEXT_GUARD_CONFIG = join(dir, "none.json");
  const fake = createFakePi({ activeTools: [TOOL] });
  const emits = [];
  fake.pi.events.on("context-guard", (d) => emits.push(d.event));
  contextGuard(fake.pi);
  const ctx = createFakeCtx({ usage: { tokens: 120000, contextWindow: 200000, percent: null }, branch });
  return { ...fake, ctx, emits };
}

test("canCompact needs keepRecentTokens of non-system conversation after the first message", () => {
  assert.equal(canCompact(tooSmall, KEEP_RECENT), false);
  assert.equal(canCompact(bigEnough, KEEP_RECENT), true);
  assert.equal(canCompact([msg("user", 50000)], KEEP_RECENT), false);
  assert.equal(canCompact([], KEEP_RECENT), false);
});

test("canCompact counts only entries after the last compaction", () => {
  const compacted = [...bigEnough, { type: "compaction", summary: "s" }, msg("user", 50), msg("assistant", 500)];
  assert.equal(canCompact(compacted, KEEP_RECENT), false);
  assert.equal(canCompact([...compacted, msg("toolResult", 25000), msg("assistant", 10)], KEEP_RECENT), true);
});

test("canCompact counts custom messages, thinking and tool calls", () => {
  const branch = [
    msg("user", 10),
    { type: "custom_message", customType: "x", content: chars(7000) },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: chars(7000) }, { type: "toolCall", name: "read", arguments: { path: chars(7000) } }] } },
  ];
  assert.equal(canCompact(branch, KEEP_RECENT), true);
});

test("over the threshold, the guard does not ask for a save when Pi could not compact", async () => {
  const s = setup(tooSmall);
  const result = await s.fire("agent_before_settle", { entries: [], context: { canContinue: false } }, s.ctx);
  assert.equal(result, undefined);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  assert.deepEqual(s.emits, []);
  assert.equal(s.ctx.compactCalls.length, 0);
});

test("over the threshold with enough conversation, the guard still saves and compacts", async () => {
  const s = setup(bigEnough);
  const result = await s.fire("agent_before_settle", { entries: [], context: { canContinue: false } }, s.ctx);
  assert.equal(result.continue, true);
  await s.fire("tool_execution_end", { toolCallId: "t", toolName: TOOL, result: textResult("ok"), isError: false }, s.ctx);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  assert.deepEqual(s.emits, ["save_requested", "save_done", "compact_requested"]);
  assert.equal(s.ctx.compactCalls.length, 1);
});
