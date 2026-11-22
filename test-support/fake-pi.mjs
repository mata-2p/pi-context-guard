// Minimal fakes for the parts of the Pi extension API these extensions use.
// Pi ships no extension test harness, so tests drive handlers directly.

export function createFakePi({ activeTools = [], settings = {} } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const busHandlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    // Like Pi, registering a direct (default) or model-only tool activates it
    // unless it declares defaultActive: false.
    registerTool(tool) {
      tools.set(tool.name, tool);
      const exposure = tool.exposure ?? "direct";
      const declarable = exposure === "direct" || exposure === "model-only";
      if (declarable && tool.defaultActive !== false && !activeTools.includes(tool.name)) {
        activeTools = [...activeTools, tool.name];
      }
    },
    getActiveTools() {
      return activeTools;
    },
    // Like Pi, unknown names are ignored.
    setActiveTools(names) {
      activeTools = names.filter((name) => tools.has(name) || activeTools.includes(name));
    },
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        exposure: tool.exposure ?? "direct",
        annotations: tool.annotations,
      }));
    },
    getSettings() {
      return settings;
    },
    events: {
      emit(channel, data) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
      on(channel, handler) {
        if (!busHandlers.has(channel)) busHandlers.set(channel, []);
        busHandlers.get(channel).push(handler);
        return () => {};
      },
    },
  };

  async function fire(event, payload, ctx) {
    let result;
    for (const handler of handlers.get(event) ?? []) {
      const value = await handler({ type: event, ...payload }, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }

  async function runCommand(name, args, ctx) {
    const command = commands.get(name);
    if (!command) throw new Error(`command not registered: ${name}`);
    await command.handler(args, ctx);
  }

  async function runTool(name, params, ctx, signal) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.execute(`call-${name}`, params, signal, () => {}, ctx);
  }

  return { pi, handlers, commands, tools, fire, runCommand, runTool };
}

export function createFakeCtx({
  hasUI = true,
  sessionId = "session-1",
  model = { provider: "anthropic", id: "claude-test" },
  usage = { tokens: 1000, contextWindow: 200000, percent: 0.5 },
  idle = true,
  pendingMessages = false,
  branch,
} = {}) {
  const notifications = [];
  const statuses = new Map();
  const compactCalls = [];
  const ctx = {
    hasUI,
    cwd: "/tmp/project-a",
    model,
    usage,
    pendingMessages,
    notifications,
    statuses,
    compactCalls,
    ui: {
      notify(message, level) {
        notifications.push([message, level]);
      },
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      ...(branch === undefined ? {} : { getBranch: () => branch }),
    },
    getContextUsage() {
      return ctx.usage ?? undefined;
    },
    isIdle: () => idle,
    hasPendingMessages: () => ctx.pendingMessages,
    compact(options = {}) {
      compactCalls.push(options);
    },
  };
  return ctx;
}

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}
