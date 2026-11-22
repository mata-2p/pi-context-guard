// Regression probes from the T6 independent verification (S9, S10).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx } from "../../../test-support/fake-pi.mjs";
import contextGuard, { redactPrivate } from "../index.ts";

const TOOL = "mem_session_summary";
const KEYS = new Set(["event", "tokens", "threshold", "window", "model", "saved", "reason"]);
let dir;

afterEach(() => {
  delete process.env.CONTEXT_GUARD_CONFIG;
  delete process.env.ENGRAM_BIN;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(useDefault = false) {
  dir = mkdtempSync(join(tmpdir(), "guard-verify-"));
  process.env.CONTEXT_GUARD_CONFIG = join(dir, "none.json");
  const fake = createFakePi({ activeTools: [TOOL] });
  const emits = [];
  fake.pi.events.on("context-guard", (data) => emits.push(data));
  const requests = [];
  contextGuard(fake.pi, useDefault ? {} : { saveToEngram: async (request) => { requests.push(request); } });
  const ctx = createFakeCtx({ usage: { tokens: 120000, contextWindow: 200000, percent: null } });
  ctx.cwd = dir;
  const before = () =>
    fake.fire("agent_before_settle", { entries: [], continue: false, context: { canContinue: false }, outcome: "completed" }, ctx);
  const compactEvent = (summary, reason, id) =>
    fake.fire("session_compact", { compactionEntry: { id, summary }, fromExtension: false, reason, willRetry: false }, ctx);
  return { fake, ctx, emits, requests, before, compactEvent, events: () => emits.map((e) => e.event) };
}

test("redactPrivate handles multiline, CRLF, multiple blocks and case variants", () => {
  assert.equal(redactPrivate("k <private>\nl1\nl2\n</private> z"), "k [REDACTED] z");
  assert.equal(redactPrivate("<private>\r\ns\r\n</private>"), "[REDACTED]");
  assert.equal(redactPrivate("<private>1</private> m <PRIVATE>2</Private>"), "[REDACTED] m [REDACTED]");
});

test("a normal settle whose continuation is rejected compacts with saved false and falls back without content on the bus", async () => {
  const s = setup();
  assert.equal((await s.before()).continue, true);
  assert.equal(await s.before(), undefined);
  await s.fake.fire("agent_settled", { aborted: false }, s.ctx);
  await s.compactEvent("Summary <private>zz-secret</private> rest", "manual", "idA");
  s.ctx.compactCalls[0].onComplete({});
  assert.deepEqual(s.events(), ["save_requested", "compact_requested", "fallback_saved", "compact_done"]);
  assert.equal(s.emits[1].saved, false);
  assert.equal(s.requests[0].topic, "session/session-1/compaction-idA");
  assert.ok(!s.requests[0].content.includes("zz-secret"));
  assert.ok(!JSON.stringify(s.emits).includes("Summary"));
  for (const e of s.emits) for (const key of Object.keys(e)) assert.ok(KEYS.has(key), key);
});

test("a hung engram binary is cut at the CLI timeout and reported as timeout", async () => {
  const s = setup(true);
  const bin = join(dir, "slow.sh");
  writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
  chmodSync(bin, 0o755);
  process.env.ENGRAM_BIN = bin;
  const started = Date.now();
  await s.compactEvent("Pi summary", "threshold", "idT");
  assert.ok(Date.now() - started < 12000);
  assert.deepEqual(s.emits.map((e) => [e.event, e.reason]), [["fallback_failed", "timeout"]]);
});
