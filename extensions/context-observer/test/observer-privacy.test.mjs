import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, createFakeCtx, textResult } from "../../../test-support/fake-pi.mjs";
import contextObserver from "../index.ts";

test("MCP-prefixed tool errors and failed compactions store no content, args or error text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-privacy-"));
  const file = join(dir, "m.jsonl");
  process.env.CONTEXT_METRICS_FILE = file;
  try {
    const fake = createFakePi();
    contextObserver(fake.pi);
    const ctx = createFakeCtx();
    await fake.fire("tool_execution_start", { toolCallId: "x", toolName: "mcp__custom-tools__bash", args: { command: "cat /etc/passwd" } }, ctx);
    await fake.fire("tool_execution_end", { toolCallId: "x", toolName: "mcp__custom-tools__bash", result: textResult("root:x:0:0"), isError: true }, ctx);
    await fake.fire("session_compact_failed", { reason: "manual", errorMessage: "Compaction failed: SECRET", aborted: false }, ctx);
    const text = readFileSync(file, "utf8");
    const [err, failed] = text.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(err).sort(), ["kind", "model", "session", "tool", "ts", "turnsSinceCompaction"]);
    assert.equal(err.tool, "bash");
    assert.equal(failed.ok, false);
    assert.doesNotMatch(text, /passwd|root:x|SECRET|mcp__/);
  } finally {
    delete process.env.CONTEXT_METRICS_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
