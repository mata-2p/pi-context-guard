// context-observer: passive metrics for context management and model lucidity.
//
// Records metrics only, never conversation content, to a local JSONL file so
// compaction thresholds can be tuned with data. It works with or without the
// context-guard extension; when the guard is present, its events arrive on the
// "context-guard" event bus channel and are recorded too.
//
// Commands:
//   /context-report  summarize recorded metrics per model
//   /context-flag    mark the moment the model lost track

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Turns after a compaction that count as "after compaction" in the report. */
export const AFTER_COMPACTION_WINDOW = 10;

const MEMORY_LOOKUP_TOOLS = new Set(["mem_search", "mem_context", "mem_get_observation"]);
const GUARD_FIELDS = ["event", "tokens", "threshold", "window", "model", "saved", "reason"];
const EMPTY_RESULT = /\b(no|0|zero)\s+(results?|memories|observations|matches)\b|\bnot found\b|"results"\s*:\s*\[\s*\]/i;

export function metricsFilePath(): string {
  if (process.env.CONTEXT_METRICS_FILE) return process.env.CONTEXT_METRICS_FILE;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "context-metrics", "metrics.jsonl");
}

/** Strips runtime prefixes such as "mcp__custom-tools__" from tool names. */
export function baseToolName(name: string): string {
  const index = name.lastIndexOf("__");
  return index === -1 ? name : name.slice(index + 2);
}

function modelKey(ctx: any): string {
  const model = ctx?.model;
  return model ? `${model.provider}/${model.id}` : "unknown";
}

function resultText(result: any): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function isEmptyLookup(result: any): boolean {
  const text = resultText(result).trim();
  return text.length === 0 || EMPTY_RESULT.test(text);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function isAfterCompaction(turnsSinceCompaction: unknown): boolean {
  return typeof turnsSinceCompaction === "number" && turnsSinceCompaction <= AFTER_COMPACTION_WINDOW;
}

function per100(count: number, turns: number): string {
  return turns === 0 ? "n/a" : (count * 100 / turns).toFixed(1);
}

export function summarize(records: any[]): any[] {
  const byModel = new Map<string, any[]>();
  for (const record of records) {
    const key = record.model ?? "unknown";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(record);
  }

  return [...byModel.entries()].map(([model, items]) => {
    const turns = items.filter((r) => r.kind === "turn");
    const tokens = turns.map((r) => r.tokens).filter((t) => typeof t === "number");
    const compactions = items.filter((r) => r.kind === "compaction");
    const byReason: Record<string, number> = {};
    for (const c of compactions) byReason[c.reason ?? "unknown"] = (byReason[c.reason ?? "unknown"] ?? 0) + 1;
    const errors = items.filter((r) => r.kind === "edit_failure" || r.kind === "tool_error");
    const lookupsAfter = items.filter((r) => r.kind === "memory_lookup" && r.afterCompaction);
    const flags = items.filter((r) => r.kind === "flag");
    const guard: Record<string, number> = {};
    for (const g of items.filter((r) => r.kind === "guard")) guard[g.event] = (guard[g.event] ?? 0) + 1;

    return {
      model,
      sessions: new Set(items.map((r) => r.session).filter(Boolean)).size,
      turns: turns.length,
      turnsAfterCompaction: turns.filter((r) => isAfterCompaction(r.turnsSinceCompaction)).length,
      window: turns.length > 0 ? turns[turns.length - 1].window ?? null : null,
      medianTokens: median(tokens),
      maxTokens: tokens.length > 0 ? Math.max(...tokens) : null,
      compactions: {
        total: compactions.length,
        failed: compactions.filter((c) => c.ok === false).length,
        byReason,
        medianTokensBefore: median(compactions.map((c) => c.tokensBefore).filter((t) => typeof t === "number")),
        medianDurationMs: median(compactions.map((c) => c.durationMs).filter((t) => typeof t === "number")),
      },
      errors: {
        afterCompaction: errors.filter((r) => isAfterCompaction(r.turnsSinceCompaction)).length,
        otherwise: errors.filter((r) => !isAfterCompaction(r.turnsSinceCompaction)).length,
        editFailures: errors.filter((r) => r.kind === "edit_failure").length,
      },
      rereadsAfterCompaction: items.filter((r) => r.kind === "reread_after_compaction").length,
      memoryLookupsAfterCompaction: {
        total: lookupsAfter.length,
        empty: lookupsAfter.filter((r) => r.empty).length,
      },
      flags: flags.length,
      flagMedianTokens: median(flags.map((f) => f.tokens).filter((t) => typeof t === "number")),
      guard,
    };
  });
}

export function formatReport(summaries: any[]): string {
  const lines = ["Context metrics report"];
  for (const s of summaries) {
    const otherTurns = s.turns - s.turnsAfterCompaction;
    const reasons = Object.entries(s.compactions.byReason).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
    const guard = Object.entries(s.guard).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
    lines.push(
      "",
      `${s.model} (sessions: ${s.sessions}, turns: ${s.turns}, window: ${s.window ?? "?"})`,
      `  Tokens per turn: median ${s.medianTokens ?? "?"}, max ${s.maxTokens ?? "?"}`,
      `  Compactions: ${s.compactions.total} (failed ${s.compactions.failed}; ${reasons}); median tokens before ${s.compactions.medianTokensBefore ?? "?"}, median duration ${s.compactions.medianDurationMs ?? "?"} ms`,
      `  Guard: ${guard}`,
      `  Errors per 100 turns: within ${AFTER_COMPACTION_WINDOW} turns after compaction ${per100(s.errors.afterCompaction, s.turnsAfterCompaction)}, otherwise ${per100(s.errors.otherwise, otherTurns)} (edit failures: ${s.errors.editFailures})`,
      `  Re-reads after compaction: ${s.rereadsAfterCompaction}; memory lookups after compaction: ${s.memoryLookupsAfterCompaction.total} (empty ${s.memoryLookupsAfterCompaction.empty})`,
      `  Flags: ${s.flags} (median tokens ${s.flagMedianTokens ?? "?"})`,
    );
  }
  return lines.join("\n");
}

export function readRecords(file: string): any[] {
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a partially written line instead of failing the whole report.
    }
  }
  return records;
}

export default function contextObserver(pi: ExtensionAPI) {
  const file = metricsFilePath();
  let lastCtx: any;
  let sessionId: string | null = null;
  let writeFailed = false;

  let turnsSinceCompaction: number | null = null;
  let readsBeforeCompaction = new Set<string>();
  let readsSinceCompaction = new Set<string>();
  let rereadsReported = new Set<string>();
  let compactionStart: { at: number; reason: string; tokensBefore: number | null } | null = null;
  const pendingArgs = new Map<string, any>();

  function resetSessionState() {
    turnsSinceCompaction = null;
    readsBeforeCompaction = new Set();
    readsSinceCompaction = new Set();
    rereadsReported = new Set();
    compactionStart = null;
    pendingArgs.clear();
  }

  function track(ctx: any): boolean {
    lastCtx = ctx;
    sessionId = ctx?.sessionManager?.getSessionId?.() ?? sessionId;
    return ctx?.hasUI === true;
  }

  function write(record: Record<string, unknown>) {
    const line = { ts: new Date().toISOString(), session: sessionId, ...record };
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(line) + "\n");
    } catch (error) {
      if (!writeFailed && lastCtx?.hasUI) {
        lastCtx.ui.notify(`context-observer: cannot write ${file}: ${(error as Error).message}`, "warning");
      }
      writeFailed = true;
    }
  }

  function usageFields(ctx: any) {
    const usage = ctx?.getContextUsage?.();
    return {
      model: modelKey(ctx),
      tokens: usage?.tokens ?? null,
      window: usage?.contextWindow ?? null,
      percent: usage?.percent ?? null,
    };
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    resetSessionState();
    track(ctx);
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (!track(ctx)) return;
    if (turnsSinceCompaction !== null) turnsSinceCompaction += 1;
    write({ kind: "turn", ...usageFields(ctx), turnsSinceCompaction });
  });

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!track(ctx)) return;
    compactionStart = {
      at: Date.now(),
      reason: event.reason,
      tokensBefore: event.preparation?.tokensBefore ?? null,
    };
  });

  function compactionRecord(event: any, ctx: any, ok: boolean) {
    const start = compactionStart;
    compactionStart = null;
    return {
      kind: "compaction",
      model: modelKey(ctx),
      ok,
      reason: event.reason ?? start?.reason ?? "unknown",
      tokensBefore: event.compactionEntry?.tokensBefore ?? start?.tokensBefore ?? null,
      durationMs: start ? Date.now() - start.at : null,
      fromExtension: event.fromExtension ?? null,
      willRetry: event.willRetry ?? null,
    };
  }

  pi.on("session_compact", async (event: any, ctx: any) => {
    if (!track(ctx)) return;
    write(compactionRecord(event, ctx, true));
    for (const path of readsSinceCompaction) readsBeforeCompaction.add(path);
    readsSinceCompaction = new Set();
    rereadsReported = new Set();
    turnsSinceCompaction = 0;
  });

  pi.on("session_compact_failed", async (event: any, ctx: any) => {
    if (!track(ctx)) return;
    write({ ...compactionRecord(event, ctx, false), aborted: event.aborted ?? null });
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    if (!track(ctx)) return;
    pendingArgs.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    if (!track(ctx)) return;
    const args = pendingArgs.get(event.toolCallId);
    pendingArgs.delete(event.toolCallId);
    const tool = baseToolName(event.toolName ?? "");
    const model = modelKey(ctx);

    if (event.isError) {
      write({ kind: tool === "edit" ? "edit_failure" : "tool_error", model, tool, turnsSinceCompaction });
      return;
    }

    if (tool === "read" && typeof args?.path === "string") {
      const path = args.path;
      if (turnsSinceCompaction !== null && readsBeforeCompaction.has(path) && !rereadsReported.has(path)) {
        rereadsReported.add(path);
        write({ kind: "reread_after_compaction", model, turnsSinceCompaction });
      }
      readsSinceCompaction.add(path);
      return;
    }

    if (MEMORY_LOOKUP_TOOLS.has(tool)) {
      write({
        kind: "memory_lookup",
        model,
        tool,
        empty: isEmptyLookup(event.result),
        afterCompaction: isAfterCompaction(turnsSinceCompaction),
        turnsSinceCompaction,
      });
    }
  });

  pi.events.on("context-guard", (data: any) => {
    if (lastCtx?.hasUI !== true || !data || typeof data !== "object") return;
    const record: Record<string, unknown> = { kind: "guard" };
    for (const field of GUARD_FIELDS) if (field in data) record[field] = data[field];
    write(record);
  });

  pi.registerCommand("context-flag", {
    description: "Flag the moment the model lost track (records context usage, no content)",
    handler: async (_args: string, ctx: any) => {
      track(ctx);
      const fields = usageFields(ctx);
      write({ kind: "flag", ...fields, turnsSinceCompaction });
      ctx.ui.notify(`Lucidity flag recorded at ${fields.tokens ?? "?"} tokens (${fields.percent ?? "?"}%).`, "info");
    },
  });

  pi.registerCommand("context-report", {
    description: "Summarize context and compaction metrics per model",
    handler: async (_args: string, ctx: any) => {
      track(ctx);
      const records = readRecords(file);
      if (records.length === 0) {
        ctx.ui.notify(`No context metrics recorded yet (${file}).`, "info");
        return;
      }
      ctx.ui.notify(`${formatReport(summarize(records))}\n\nSource: ${file}`, "info");
    },
  });
}
