const counter = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, missing: 0 });
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value) => typeof value === "string" && value.length ? value : undefined;
const lookup = (map, key) => key && Object.hasOwn(map, key) ? map[key] : undefined;
function own(map, key, create) {
  if (!Object.hasOwn(map, key)) {
    Object.defineProperty(map, key, { value: create(), enumerable: true, writable: true, configurable: true });
  }
  return map[key];
}

export function createMetrics(sessionId, now = new Date().toISOString()) {
  return {
    version: 1, sessionId, startedAt: now, updatedAt: now,
    currentModel: null, modelWarning: null, lastRootModel: null, total: counter(),
    root: counter(), other: counter(), unknownSubagent: counter(),
    models: {}, agents: {}, aliases: {}, seen: [],
  };
}

export function setCurrentModel(state, model) {
  state.currentModel = text(model) ?? null;
}

function agent(state, key) {
  return own(state.agents, key, () => ({
    id: key, model: null, status: "observed", usage: counter(), reportedTotal: null,
  }));
}

function agentKey(state, id, tool) {
  const byTool = lookup(state.aliases, tool);
  const byId = lookup(state.aliases, id);
  const key = byTool || byId || id || tool;
  if (byTool && byId && byTool !== byId) {
    const keep = agent(state, key);
    const discard = agent(state, byId);
    for (const field of Object.keys(keep.usage)) keep.usage[field] += discard.usage[field];
    keep.model ??= discard.model;
    keep.reportedTotal ??= discard.reportedTotal;
    delete state.agents[byId];
    for (const alias of Object.keys(state.aliases)) {
      if (state.aliases[alias] === byId) state.aliases[alias] = key;
    }
  }
  if (tool) own(state.aliases, tool, () => key);
  if (id) own(state.aliases, id, () => key);
  return key;
}

function add(target, data) {
  target.calls++;
  if (!number(data.inputTokens) || !number(data.outputTokens)) target.missing++;
  target.input += number(data.inputTokens) ? data.inputTokens : 0;
  target.output += number(data.outputTokens) ? data.outputTokens : 0;
  target.cacheRead += number(data.cacheReadTokens) ? data.cacheReadTokens : 0;
  target.cacheWrite += number(data.cacheWriteTokens) ? data.cacheWriteTokens : 0;
}

export function applyEvent(state, event) {
  if (!event || typeof event.id !== "string" || !event.id || !event.data) return false;
  const supported = ["assistant.usage", "session.model_change", "subagent.started",
    "subagent.configured", "subagent.completed", "subagent.failed"];
  if (!supported.includes(event.type) || state.seen.includes(event.id)) return false;
  const d = event.data;
  state.seen.push(event.id);
  state.updatedAt = new Date().toISOString();
  if (event.type === "session.model_change") {
    if (!event.agentId) setCurrentModel(state, d.newModel);
    return true;
  }
  if (event.type.startsWith("subagent.")) {
    const tool = text(d.toolCallId);
    const id = text(event.agentId);
    if (!tool && !id) return true;
    const key = agentKey(state, id, tool);
    const row = agent(state, key);
    row.model = text(d.model) ?? row.model;
    row.status = event.type.slice("subagent.".length);
    if (number(d.totalTokens)) row.reportedTotal = d.totalTokens;
    return true;
  }
  const model = text(d.model) ?? "(unknown model)";
  add(state.total, d);
  add(own(state.models, model, counter), d);
  const id = text(event.agentId);
  const tool = text(d.parentToolCallId);
  if (id || tool) {
    const key = agentKey(state, id, tool);
    const row = agent(state, key);
    row.model = model;
    add(row.usage, d);
  } else if (d.initiator === "sub-agent" || d.interactionType === "conversation-subagent") {
    add(state.unknownSubagent, d);
  } else if (d.initiator || (d.interactionType && d.interactionType !== "conversation-agent" &&
      d.interactionType !== "conversation-user")) {
    add(state.other, d);
  } else {
    state.lastRootModel = model;
    add(state.root, d);
  }
  return true;
}
