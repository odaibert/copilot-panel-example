import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, createMetrics, setCurrentModel } from "../lib/metrics.mjs";

const event = (id, type, data, agentId) => ({ id, type, data, agentId });
const call = (id, data = {}, agentId) => event(id, "assistant.usage",
  { model: "model-a", inputTokens: 100, outputTokens: 20, ...data }, agentId);

test("usage uses per-call models, deduplicates events, and does not add cache twice", () => {
  const state = createMetrics("one");
  const usage = call("a", { cacheReadTokens: 80, cacheWriteTokens: 10 });
  assert.equal(applyEvent(state, usage), true);
  assert.equal(applyEvent(state, usage), false);
  applyEvent(state, call("b", { model: "model-b", inputTokens: 30 }));
  assert.equal(state.total.input, 130);
  assert.equal(state.total.output, 40);
  assert.equal(state.total.cacheRead, 80);
  assert.equal(state.total.cacheWrite, 10);
  assert.equal(state.total.calls, 2);
  assert.equal(state.models["model-a"].input, 100);
  assert.equal(state.models["model-b"].input, 30);
});

test("selection switches do not fabricate usage or follow subagent models", () => {
  const state = createMetrics("one");
  setCurrentModel(state, "auto");
  applyEvent(state, call("a"));
  applyEvent(state, event("switch", "session.model_change", { newModel: "model-b" }));
  applyEvent(state, event("child-switch", "session.model_change", { newModel: "child-model" }, "child"));
  applyEvent(state, call("b", { model: "child-model" }, "child"));
  assert.equal(state.currentModel, "model-b");
  assert.equal(state.lastRootModel, "model-a");
  assert.equal(state.total.calls, 2);
});

test("agent ID, legacy parent tool ID, unknown subagent and other calls stay separate", () => {
  const state = createMetrics("one");
  applyEvent(state, event("start", "subagent.started", { toolCallId: "tool-1", model: "model-a" }, "agent-1"));
  applyEvent(state, call("legacy", { parentToolCallId: "tool-1" }));
  applyEvent(state, call("modern", {}, "agent-1"));
  applyEvent(state, call("unknown", { interactionType: "conversation-subagent" }));
  applyEvent(state, call("unknown-2", { initiator: "sub-agent" }));
  applyEvent(state, call("sampling", { initiator: "mcp-sampling" }));
  applyEvent(state, call("root"));
  applyEvent(state, event("done", "subagent.completed", { toolCallId: "tool-1", totalTokens: 999 }));
  assert.equal(Object.keys(state.agents).length, 1);
  assert.equal(state.agents["agent-1"].usage.input, 200);
  assert.equal(state.agents["agent-1"].reportedTotal, 999);
  assert.equal(state.agents["agent-1"].status, "completed");
  assert.equal(state.unknownSubagent.calls, 2);
  assert.equal(state.other.calls, 1);
  assert.equal(state.root.calls, 1);
  assert.equal(state.total.input, 600);
});

test("late ID to tool mapping merges previously separate observed counters once", () => {
  const state = createMetrics("one");
  applyEvent(state, event("start", "subagent.started", { toolCallId: "tool-1" }));
  applyEvent(state, call("a", {}, "agent-1"));
  applyEvent(state, call("b", { parentToolCallId: "tool-1" }));
  applyEvent(state, call("link", { parentToolCallId: "tool-1" }, "agent-1"));
  assert.equal(Object.keys(state.agents).length, 1);
  assert.equal(state.agents["tool-1"].usage.input, 300);
  assert.equal(state.total.input, 300);
});

test("missing/invalid counters are marked incomplete, not coerced or inferred", () => {
  const state = createMetrics("one");
  applyEvent(state, call("a", { inputTokens: undefined, outputTokens: -5, model: undefined }));
  applyEvent(state, call("b", { inputTokens: NaN, outputTokens: "500" }));
  assert.equal(state.total.input, 0);
  assert.equal(state.total.output, 0);
  assert.equal(state.total.missing, 2);
  assert.ok(state.models["(unknown model)"]);
  assert.equal(applyEvent(state, { type: "assistant.usage", data: {} }), false);
});

test("prototype-shaped metadata is safe, and prompt/tool payloads are not retained", () => {
  const state = createMetrics("one");
  applyEvent(state, call("a", { model: "__proto__", content: "private payload", toolArgs: "private payload" }, "__proto__"));
  applyEvent(state, event("tool", "tool.execution_start", { content: "private payload" }));
  assert.equal(state.models["__proto__"].input, 100);
  assert.equal(state.agents["__proto__"].usage.calls, 1);
  assert.equal(JSON.stringify(state).includes("private payload"), false);
  assert.equal({}.input, undefined);
});
