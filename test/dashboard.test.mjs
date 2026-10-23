import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "../lib/dashboard.mjs";

async function setup(t, capabilities = { ui: { elicitation: true } }) {
  const listeners = new Set();
  const dialogs = [];
  let config;
  const session = {
    sessionId: "foreground", capabilities,
    rpc: { model: { getCurrent: async () => ({ modelId: "auto" }) } },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    ui: { async elicitation(payload) { dialogs.push(payload); return { action: "cancel" }; } },
    emit(event) { for (const fn of listeners) fn(event); },
  };
  const { collector } = await startDashboard(async (value) => { config = value; return session; });
  t.after(() => collector.stop());
  assert.equal(config.commands.length, 1);
  const command = config.commands[0];
  assert.equal(command.name, "odaibert-dashboard");
  assert.equal(typeof command.handler, "function");
  return { session, command, dialogs, collector };
}

test("registered command uses a fieldless native dialog with observed counters, not a model request", async (t) => {
  const { session, command, dialogs } = await setup(t);
  session.emit({ id: "main", type: "assistant.usage",
    data: { model: "main-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, content: "PRIVATE" } });
  const child = { id: "child-call", agentId: "child-1", type: "assistant.usage",
    data: { model: "child-model", inputTokens: 42, outputTokens: 7 } };
  session.emit(child);
  session.emit(child);
  session.emit({ id: "done", type: "subagent.completed", agentId: "child-1",
    data: { totalTokens: 999 } });
  await command.handler();
  assert.deepEqual(dialogs[0].requestedSchema, { type: "object", properties: {} });
  const message = dialogs[0].message;
  assert.match(message, /Current model: auto/);
  assert.match(message, /Last main call: main-model/);
  assert.match(message, /Observed total: 142 in \/ 27 out \(2 calls\)/);
  assert.match(message, /main-model: 100 in \/ 20 out/);
  assert.match(message, /child-model: 42 in \/ 7 out/);
  assert.match(message, /child-1 — completed — child-model/);
  assert.match(message, /Lifecycle reported total: 999 \(not added/);
  assert.match(message, /Cache read: 80 \/ write: 0/);
  assert.match(message, /not the live \/tasks panel/);
  assert.match(message, /reset on extension reload/);
  assert.equal(message.includes("PRIVATE"), false);
  session.emit({ id: "missing", type: "assistant.usage", data: { model: "main-model", outputTokens: 3 } });
  assert.equal(dialogs[0].message, message);
  session.rpc.model.getCurrent = async () => ({ modelId: "changed-model" });
  await command.handler();
  assert.match(dialogs[1].message, /Current model: changed-model/);
  assert.match(dialogs[1].message, /Observed total: 142 in \/ 30 out \(3 calls\)/);
  assert.match(dialogs[1].message, /WARNING: Incomplete input\/output counts in 1 calls/);
});

test("unsupported native UI rejects through the command handler while collection continues", async (t) => {
  const { session, command, dialogs, collector } = await setup(t, {});
  await assert.rejects(command.handler(), /requires a Copilot CLI host with native elicitation/);
  assert.equal(dialogs.length, 0);
  session.emit({ id: "after-error", type: "assistant.usage", data: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(collector.state.total.input, 1);
});

test("dialog transport failures reject without disabling the collector or later commands", async (t) => {
  const { session, command, dialogs, collector } = await setup(t);
  const original = session.ui.elicitation;
  session.ui.elicitation = async () => { throw new Error("host failure"); };
  await assert.rejects(command.handler(), /could not open the native snapshot dialog/);
  session.emit({ id: "after-error", type: "assistant.usage", data: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(collector.state.total.output, 2);
  session.ui.elicitation = original;
  await command.handler();
  assert.equal(dialogs.length, 1);
});

test("unknown models, empty usage, and control characters are handled without fabricated counters", async (t) => {
  const { session, command, dialogs } = await setup(t);
  session.rpc.model.getCurrent = async () => { throw new Error("not supported"); };
  session.emit({ id: "unknown", type: "session.model_change", data: {} });
  await command.handler();
  assert.match(dialogs[0].message, /Current model: unknown/);
  assert.match(dialogs[0].message, /Current model query unavailable/);
  assert.match(dialogs[0].message, /No model calls observed/);
  session.rpc.model.getCurrent = async () => ({ modelId: "\x1b[31munsafe\x07" });
  await command.handler();
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(dialogs[1].message), false);
});
