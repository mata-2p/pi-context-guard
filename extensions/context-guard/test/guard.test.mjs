import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";
import contextGuard, { computeThreshold } from "../index.ts";

const SUMMARY_TOOL = "mcp__custom-tools__mem_session_summary";
const DEFAULTS = { enabled: true, ratio: 0.5, capTokens: 150000, floorMultiplier: 2 };
const dirs = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CONTEXT_GUARD_CONFIG;
  delete process.env.CONTEXT_GUARD_DISABLED;
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

// Window 200000 with default settings gives a threshold of 100000.
function setup({ config, activeTools = ["read", SUMMARY_TOOL], settings = {}, tokens = 50000, ...ctxOptions } = {}) {
  const dir = scratch();
  const configFile = join(dir, "context-guard.json");
  if (config !== undefined) writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
  process.env.CONTEXT_GUARD_CONFIG = configFile;
  const fake = createFakePi({ activeTools, settings });
  const emits = [];
  fake.pi.events.on("context-guard", (data) => emits.push(data));
  contextGuard(fake.pi);
  const ctx = createFakeCtx({ usage: { tokens, contextWindow: 200000, percent: null }, ...ctxOptions });
  const setTokens = (value) => {
    ctx.usage = { tokens: value, contextWindow: 200000, percent: null };
  };
  // Pi builds this context before any handler adds entries, so at a normal end
  // of run the last message is the assistant reply and canContinue is false.
  const beforeSettle = (context = { canContinue: false }) =>
    fake.fire("agent_before_settle", { entries: [], continue: false, context, outcome: "completed" }, ctx);
  const settled = (aborted = false) => fake.fire("agent_settled", { aborted }, ctx);
  const saveSummary = (isError = false) =>
    fake.fire("tool_execution_end", { toolCallId: "t1", toolName: SUMMARY_TOOL, result: textResult("saved"), isError }, ctx);
  return { ...fake, ctx, emits, setTokens, beforeSettle, settled, saveSummary, events: () => emits.map((e) => e.event) };
}

test("computeThreshold pins the documented examples", () => {
  assert.equal(computeThreshold(128000, 20000, 16384, DEFAULTS), 64000);
  assert.equal(computeThreshold(200000, 20000, 16384, DEFAULTS), 100000);
  assert.equal(computeThreshold(1000000, 20000, 16384, DEFAULTS), 150000);
  assert.equal(computeThreshold(50000, 20000, 16384, DEFAULTS), null);
});

test("computeThreshold applies the floor and rounds down", () => {
  assert.equal(computeThreshold(100000, 30000, 16384, DEFAULTS), 60000);
  assert.equal(computeThreshold(100001, 20000, 16384, DEFAULTS), 50000);
});

test("below the threshold nothing happens", async () => {
  const s = setup({ tokens: 99999 });
  assert.equal(await s.beforeSettle(), undefined);
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 0);
  assert.deepEqual(s.emits, []);
});

test("crossing the threshold requests the save once with continue", async () => {
  const s = setup({ tokens: 100000 });
  const result = await s.beforeSettle();
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  const [entry] = result.entries;
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.customType, "context-guard");
  assert.equal(entry.display, true);
  assert.match(entry.content, /100000 tokens/);
  assert.match(entry.content, /threshold 100000/);
  assert.match(entry.content, /mem_session_summary/);
  for (const section of ["## Goal", "## Instructions", "## Discoveries", "## Accomplished", "## Next Steps", "## Relevant Files"]) {
    assert.ok(entry.content.includes(section), section);
  }
  assert.match(entry.content, /compacted automatically/);
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, [
    { event: "save_requested", tokens: 100000, threshold: 100000, window: 200000, model: "anthropic/claude-test" },
  ]);
});

test("a normal settle (canContinue false before the guard's entry) still requests the save", async () => {
  const s = setup({ tokens: 120000 });
  const result = await s.beforeSettle({ canContinue: false });
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(s.events(), ["save_requested"]);
});

test("a settle with queued messages (canContinue true) still requests the save once", async () => {
  const s = setup({ tokens: 120000 });
  assert.equal((await s.beforeSettle({ canContinue: true })).continue, true);
  assert.equal(await s.beforeSettle({ canContinue: true }), undefined);
  assert.deepEqual(s.events(), ["save_requested"]);
});

test("an observed save leads to one compaction with saved true", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.saveSummary();
  await s.beforeSettle();
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 1);
  assert.equal(typeof s.ctx.compactCalls[0].onComplete, "function");
  assert.equal(typeof s.ctx.compactCalls[0].onError, "function");
  assert.deepEqual(s.events(), ["save_requested", "save_done", "compact_requested"]);
  assert.equal(s.emits[2].saved, true);
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 1);
});

test("a failed save still compacts with saved false", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.saveSummary(true);
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 1);
  assert.deepEqual(s.events(), ["save_requested", "compact_requested"]);
  assert.equal(s.emits[1].saved, false);
});

test("an aborted run skips the compaction and re-arms", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.settled(true);
  assert.equal(s.ctx.compactCalls.length, 0);
  assert.deepEqual(s.events(), ["save_requested", "compact_skipped"]);
  assert.equal(s.emits[1].reason, "aborted");
  assert.equal((await s.beforeSettle()).continue, true);
});

test("pending messages delay the compaction to a later settle", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.saveSummary();
  s.ctx.pendingMessages = true;
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 0);
  assert.equal(await s.beforeSettle(), undefined);
  s.ctx.pendingMessages = false;
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 1);
  assert.equal(s.emits.at(-1).saved, true);
});

test("null or missing usage never triggers", async () => {
  const s = setup();
  s.ctx.usage = { tokens: null, contextWindow: 200000, percent: null };
  assert.equal(await s.beforeSettle(), undefined);
  s.ctx.usage = undefined;
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});

test("inactive without UI", async () => {
  const s = setup({ tokens: 120000, hasUI: false });
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});

test("inactive when mem_session_summary is not an active tool", async () => {
  const s = setup({ tokens: 120000, activeTools: ["read", "mem_save"] });
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});

test("inactive with CONTEXT_GUARD_DISABLED=1", async () => {
  process.env.CONTEXT_GUARD_DISABLED = "1";
  const s = setup({ tokens: 120000 });
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});

test("inactive with enabled false in the config file", async () => {
  const s = setup({ tokens: 120000, config: { enabled: false } });
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});

test("compaction failure backs off for 3 settles", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.settled();
  s.ctx.compactCalls[0].onError(new Error("boom"));
  assert.equal(s.events().at(-1), "compact_failed");
  assert.equal(s.emits.at(-1).reason, "error");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await s.beforeSettle(), undefined);
    await s.settled();
  }
  assert.equal(s.ctx.compactCalls.length, 1);
  assert.equal((await s.beforeSettle()).continue, true);
});

test("compaction completion re-arms the guard", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.settled();
  s.ctx.compactCalls[0].onComplete({ summary: "ignored" });
  assert.equal(s.events().at(-1), "compact_done");
  assert.equal((await s.beforeSettle()).continue, true);
});

test("any session_compact resets the guard to idle", async () => {
  const s = setup({ tokens: 120000 });
  await s.beforeSettle();
  await s.fire("session_compact", { reason: "manual" }, s.ctx);
  await s.settled();
  assert.equal(s.ctx.compactCalls.length, 0);
  // Re-armed, but the first reading after a compaction is the growth baseline.
  assert.equal(await s.beforeSettle(), undefined);
  s.ctx.usage = { ...s.ctx.usage, tokens: 140000 };
  assert.equal((await s.beforeSettle()).continue, true);
});

test("the config file overrides the ratio", async () => {
  const s = setup({ tokens: 60000, config: { ratio: 0.25 } });
  assert.equal((await s.beforeSettle()).continue, true);
  assert.equal(s.emits[0].threshold, 50000);
});

test("an invalid config file warns once and uses defaults", async () => {
  const s = setup({ tokens: 99999, config: "{not json" });
  await s.fire("session_start", { reason: "startup" }, s.ctx);
  assert.equal(await s.beforeSettle(), undefined);
  s.setTokens(100000);
  assert.equal((await s.beforeSettle()).continue, true);
  const warnings = s.ctx.notifications.filter(([, level]) => level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /context-guard/);
});

test("a model override for keepRecentTokens raises the floor", async () => {
  const settings = {
    compaction: { keepRecentTokens: 20000, modelOverrides: { "anthropic/claude-test": { keepRecentTokens: 60000 } } },
  };
  const s = setup({ tokens: 119999, settings });
  assert.equal(await s.beforeSettle(), undefined);
  s.setTokens(120000);
  assert.equal((await s.beforeSettle()).continue, true);
  assert.equal(s.emits[0].threshold, 120000);
});

test("a large reserveTokens setting disables the guard for that window", async () => {
  const s = setup({ tokens: 150000, settings: { compaction: { reserveTokens: 100000 } } });
  assert.equal(await s.beforeSettle(), undefined);
  assert.deepEqual(s.emits, []);
});
