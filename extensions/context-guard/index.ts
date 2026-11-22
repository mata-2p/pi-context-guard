// context-guard: save to Engram and compact at a model-independent threshold.
//
// When context usage crosses the threshold at the end of a run, the guard asks
// the model for one more turn to call mem_session_summary, then compacts once
// the agent is fully idle. Pi's own reserveTokens compaction stays untouched as
// the overflow fallback. Events go to the "context-guard" bus channel (no
// content) so the context-observer can record them.
//
// Fallback: when a compaction completes without an observed mem_session_summary
// save (the guard's own with saved false, or Pi's threshold/overflow/manual
// ones), the guard stores Pi's compaction summary with `engram save` under a
// unique topic per session and compaction. Binary: $ENGRAM_BIN or engram.
//
// Config: JSON at $CONTEXT_GUARD_CONFIG or $PI_CODING_AGENT_DIR/context-guard.json
// Kill switch: CONTEXT_GUARD_DISABLED=1 or {"enabled": false}

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GuardConfig = { enabled: boolean; ratio: number; capTokens: number; floorMultiplier: number };

export const DEFAULT_CONFIG: GuardConfig = { enabled: true, ratio: 0.5, capTokens: 150000, floorMultiplier: 2 };

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const DEFAULT_RESERVE_TOKENS = 16384;
const FAILURE_BACKOFF_SETTLES = 3;
const SUMMARY_TOOL = "mem_session_summary";
// Linux caps a single argv entry at 131072 bytes.
const MAX_FALLBACK_BYTES = 99999;
const ENGRAM_TIMEOUT_MS = 10000;
const TRUNCATED_MARKER = "\n[truncated]";

export function configFilePath(): string {
  if (process.env.CONTEXT_GUARD_CONFIG) return process.env.CONTEXT_GUARD_CONFIG;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "context-guard.json");
}

/** Reads the config file; a missing file gives defaults, an invalid one also a warning. */
export function loadConfig(file: string = configFilePath()): { config: GuardConfig; warning: string | null } {
  if (!existsSync(file)) return { config: { ...DEFAULT_CONFIG }, warning: null };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, warning: `context-guard: invalid config ${file}: ${(error as Error).message}; using defaults` };
  }
  const valid =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
    (raw.enabled === undefined || typeof raw.enabled === "boolean") &&
    ["ratio", "capTokens", "floorMultiplier"].every((key) => raw[key] === undefined || (typeof raw[key] === "number" && raw[key] > 0));
  if (!valid) return { config: { ...DEFAULT_CONFIG }, warning: `context-guard: invalid config ${file}; using defaults` };
  return { config: { ...DEFAULT_CONFIG, ...raw }, warning: null };
}

/** Returns the guard threshold, or null when Pi's built-in compaction owns this window. */
export function computeThreshold(window: number, keepRecentTokens: number, reserveTokens: number, config: GuardConfig): number | null {
  const threshold = Math.floor(Math.max(Math.min(config.ratio * window, config.capTokens), config.floorMultiplier * keepRecentTokens));
  return threshold >= window - reserveTokens ? null : threshold;
}

/** Resolves keepRecentTokens and reserveTokens: model override, then setting, then default. */
export function compactionSettings(settings: any, model: string): { keepRecentTokens: number; reserveTokens: number } {
  const compaction = settings?.compaction ?? {};
  const override = compaction.modelOverrides?.[model] ?? {};
  return {
    keepRecentTokens: override.keepRecentTokens ?? compaction.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    reserveTokens: override.reserveTokens ?? compaction.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
  };
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

export function saveInstruction(tokens: number, threshold: number, tool: string): string {
  return [
    `Context reached ${tokens} tokens (threshold ${threshold}).`,
    `Call \`${tool}\` now with a structured summary of this session using these sections:`,
    "## Goal, ## Instructions, ## Discoveries, ## Accomplished, ## Next Steps, ## Relevant Files.",
    "Start no new work. After saving, reply with one short line.",
    "The session will be compacted automatically.",
  ].join("\n");
}

/** Replaces <private>…</private> blocks, same convention as gentle-engram. */
export function redactPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

/** Cuts text to at most maxBytes of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to a code point boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export type FallbackRequest = { title: string; content: string; type: string; scope: string; topic: string; cwd: string };

/** Builds the Engram record for Pi's compaction summary, or null when there is none. */
export function buildFallbackRequest(input: { summary: unknown; reason: string; sessionId: string; compaction: number; entryId?: unknown; cwd: string }): FallbackRequest | null {
  if (typeof input.summary !== "string" || input.summary.trim() === "") return null;
  // The header also keeps the argv entry from starting with "-".
  const header = `The model did not save a session summary before this compaction (reason ${input.reason}); this is Pi's compaction summary.`;
  let content = `${header}\n\n${redactPrivate(input.summary)}`.replaceAll("\u0000", "");
  if (Buffer.byteLength(content, "utf8") > MAX_FALLBACK_BYTES) {
    content = truncateUtf8(content, MAX_FALLBACK_BYTES - Buffer.byteLength(TRUNCATED_MARKER)) + TRUNCATED_MARKER;
  }
  return {
    title: `Context guard fallback summary (compaction ${input.compaction})`,
    content,
    type: "session_summary",
    scope: "project",
    // Pi's compaction entry id is unique even when a resumed session restarts
    // the counter, so an earlier fallback record is never upserted over.
    topic: `session/${input.sessionId}/compaction-${typeof input.entryId === "string" && input.entryId ? input.entryId : input.compaction}`,
    cwd: input.cwd,
  };
}

/** Runs `engram save` without a shell; rejects with the execFile error. */
export function saveWithEngramCli(request: FallbackRequest): Promise<void> {
  const args = ["save", request.title, request.content, "--type", request.type, "--scope", request.scope, "--topic", request.topic];
  return new Promise((resolve, reject) => {
    execFile(process.env.ENGRAM_BIN || "engram", args, { cwd: request.cwd, timeout: ENGRAM_TIMEOUT_MS }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Maps a saver error to a bus reason; the error text never leaves the guard. */
export function fallbackFailureReason(error: any): "unavailable" | "timeout" | "error" {
  if (error?.code === "ENOENT") return "unavailable";
  if (error?.killed === true || error?.code === "ETIMEDOUT") return "timeout";
  return "error";
}

type Phase = "idle" | "save_requested" | "compacting";

export type GuardDeps = { saveToEngram?: (request: FallbackRequest) => Promise<void> };

export default function contextGuard(pi: ExtensionAPI, deps: GuardDeps = {}) {
  const saveToEngram = deps.saveToEngram ?? saveWithEngramCli;
  const disabled = process.env.CONTEXT_GUARD_DISABLED === "1";
  const { config, warning } = loadConfig();
  let warned = false;

  let phase: Phase = "idle";
  let saved = false;
  let backoff = 0;
  let compactions = 0;
  // First token reading after a compaction. When the compacted context is
  // still near the threshold (large system prompt, small window), the guard
  // waits for keepRecentTokens of growth so it does not compact every turn.
  let awaitingBaseline = false;
  let baseline: number | null = null;

  function reset() {
    phase = "idle";
    saved = false;
  }

  function warnOnce(ctx: any) {
    if (warning && !warned && ctx?.hasUI === true) {
      warned = true;
      ctx.ui.notify(warning, "warning");
    }
  }

  function measure(ctx: any) {
    const usage = ctx?.getContextUsage?.();
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : null;
    const window = usage?.contextWindow ?? ctx?.model?.contextWindow ?? null;
    const model = modelKey(ctx);
    let threshold: number | null = null;
    if (typeof window === "number" && window > 0) {
      const { keepRecentTokens, reserveTokens } = compactionSettings(pi.getSettings?.(), model);
      threshold = computeThreshold(window, keepRecentTokens, reserveTokens, config);
    }
    return { tokens, threshold, window, model };
  }

  function emit(ctx: any, event: string, extra: Record<string, unknown> = {}) {
    pi.events.emit("context-guard", { event, ...measure(ctx), ...extra });
  }

  function summaryTool(): string | undefined {
    return pi.getActiveTools().find((name) => baseToolName(name) === SUMMARY_TOOL);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    reset();
    backoff = 0;
    compactions = 0;
    awaitingBaseline = false;
    baseline = null;
    warnOnce(ctx);
  });

  async function saveFallback(event: any, ctx: any, compaction: number) {
    const reason = typeof event?.reason === "string" ? event.reason : "unknown";
    try {
      const request = buildFallbackRequest({
        summary: event?.compactionEntry?.summary,
        reason,
        sessionId: ctx.sessionManager?.getSessionId?.() ?? "unknown",
        compaction,
        entryId: event?.compactionEntry?.id,
        cwd: ctx.cwd,
      });
      if (!request) {
        emit(ctx, "fallback_failed", { reason: "no_summary" });
        return;
      }
      try {
        await saveToEngram(request);
      } catch (error) {
        emit(ctx, "fallback_failed", { reason: fallbackFailureReason(error) });
        return;
      }
      emit(ctx, "fallback_saved", { reason });
    } catch {
      // Never break Pi's compaction flow.
    }
  }

  pi.on("session_compact", async (event: any, ctx: any) => {
    compactions += 1;
    // saved is only true after an observed save in save_requested/compacting,
    // so every other compaction (Pi threshold/overflow, manual) needs a fallback.
    const needsFallback = !saved;
    reset();
    awaitingBaseline = true;
    baseline = null;
    if (!needsFallback || disabled || !config.enabled || ctx?.hasUI !== true) return;
    // Awaited (bounded by the CLI timeout) so fallback events precede compact_done.
    await saveFallback(event, ctx, compactions);
  });

  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    warnOnce(ctx);
    if (phase !== "idle" || backoff > 0) return;
    if (disabled || !config.enabled || ctx?.hasUI !== true) return;
    // event.context.canContinue is not checked: Pi builds it before this
    // handler adds its entry, so at a normal settle (last message is the
    // assistant reply) it is always false. Pi re-validates the continuation
    // after committing the guard's custom_message.
    const tool = summaryTool();
    if (!tool) return;
    const { tokens, threshold, model } = measure(ctx);
    if (tokens === null) return;
    if (awaitingBaseline) {
      awaitingBaseline = false;
      baseline = tokens;
    }
    if (threshold === null || tokens < threshold) return;
    const { keepRecentTokens } = compactionSettings(pi.getSettings?.(), model);
    if (baseline !== null && tokens < baseline + keepRecentTokens) return;

    phase = "save_requested";
    saved = false;
    emit(ctx, "save_requested");
    // Pi replaces the accumulated entries with the returned array, so keep the
    // ones earlier extensions proposed and append the guard's after them.
    const earlier = Array.isArray(event?.entries) ? event.entries : [];
    return {
      entries: [...earlier, { type: "custom_message", customType: "context-guard", display: true, content: saveInstruction(tokens, threshold, tool) }],
      continue: true,
    };
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    if (phase !== "save_requested" || event.isError) return;
    if (baseToolName(event.toolName ?? "") !== SUMMARY_TOOL) return;
    saved = true;
    emit(ctx, "save_done");
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    if (phase !== "save_requested") {
      if (backoff > 0) backoff -= 1;
      return;
    }
    if (event.aborted) {
      reset();
      emit(ctx, "compact_skipped", { reason: "aborted" });
      return;
    }
    // Retry on a later settle so queued user messages are not dropped.
    if (ctx.hasPendingMessages?.()) return;

    phase = "compacting";
    emit(ctx, "compact_requested", { saved });
    ctx.compact({
      onComplete: () => {
        reset();
        emit(ctx, "compact_done");
      },
      // The error text is not forwarded: bus events carry metrics only.
      onError: () => {
        reset();
        backoff = FAILURE_BACKOFF_SETTLES;
        emit(ctx, "compact_failed", { reason: "error" });
      },
    });
  });
}
