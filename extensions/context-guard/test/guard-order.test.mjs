import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";
import contextGuard from "../index.ts";

const TOOL = "mem_session_summary";
let dir;
afterEach(() => {
  delete process.env.CONTEXT_GUARD_CONFIG;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(tokens, contextWindow = 200000) {
  dir = mkdtempSync(join(tmpdir(), "guard-order-"));
  process.env.CONTEXT_GUARD_CONFIG = join(dir, "none.json");
  const fake = createFakePi({ activeTools: [TOOL] });
  const emits = [];
  fake.pi.events.on("context-guard", (d) => emits.push(d.event));
  contextGuard(fake.pi);
  const ctx = createFakeCtx({ usage: { tokens, contextWindow, percent: null } });
  return { ...fake, ctx, emits };
}

async function saveAndCompact(s) {
  await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx);
  await s.fire("tool_execution_end", { toolCallId: "t", toolName: TOOL, result: textResult("ok"), isError: false }, s.ctx);
  await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  // Pi emits session_compact before calling onComplete.
  await s.fire("session_compact", { reason: "manual" }, s.ctx);
  s.ctx.compactCalls.at(-1).onComplete({});
}

test("session_compact during the guard's own compaction does not cause a second compaction", async () => {
  const s = setup(120000);
  await saveAndCompact(s);
  s.ctx.usage = { tokens: null, contextWindow: 200000, percent: null };
  assert.equal(await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx), undefined);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  assert.equal(s.ctx.compactCalls.length, 1);
  assert.deepEqual(s.emits, ["save_requested", "save_done", "compact_requested", "compact_done"]);
});

test("agent_before_settle keeps entries proposed by earlier extensions, in order, before the guard's", async () => {
  // Pi replaces the accumulated entries with the array a handler returns
  // (runner.js emitBoundary), so the guard must append to event.entries.
  const s = setup(120000);
  const earlier = { type: "custom_message", customType: "earlier-extension", display: false, content: "earlier" };
  const result = await s.fire("agent_before_settle", { entries: [earlier], context: { canContinue: false } }, s.ctx);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0], earlier);
  assert.equal(result.entries[1].customType, "context-guard");
  assert.deepEqual(s.emits, ["save_requested"]);
});

test("after a compaction the guard waits for keepRecentTokens of growth before asking again", async () => {
  // 128K window: threshold 64000, keepRecentTokens 20000 by default.
  const s = setup(70000, 128000);
  await saveAndCompact(s);

  // The post-compaction context is still above the threshold (large system prompt).
  s.ctx.usage = { tokens: 66000, contextWindow: 128000, percent: null };
  assert.equal(await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx), undefined);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  s.ctx.usage = { tokens: 85000, contextWindow: 128000, percent: null };
  assert.equal(await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx), undefined);
  await s.fire("agent_settled", { aborted: false }, s.ctx);
  assert.equal(s.ctx.compactCalls.length, 1);

  s.ctx.usage = { tokens: 86000, contextWindow: 128000, percent: null };
  const result = await s.fire("agent_before_settle", { context: { canContinue: false } }, s.ctx);
  assert.equal(result.continue, true);
  assert.equal(s.emits.filter((e) => e === "save_requested").length, 2);
});
