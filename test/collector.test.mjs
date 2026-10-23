import test from "node:test";
import assert from "node:assert/strict";
import { collect } from "../lib/collector.mjs";

function session(id = "foreground", get = async () => ({ modelId: "selected-model" })) {
  const listeners = new Set();
  return {
    sessionId: id, rpc: { model: { getCurrent: get } },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { for (const fn of listeners) fn(event); },
  };
}
const usage = (id) => ({ id, type: "assistant.usage", data: { model: "m", inputTokens: 3, outputTokens: 2 } });

test("in-memory counters deduplicate, isolate sessions, and reset on reattachment", async () => {
  const first = session("first");
  const collector = await collect(first);
  first.emit(usage("one"));
  first.emit(usage("one"));
  assert.equal(collector.state.total.input, 3);
  const second = session("second");
  const next = await collect(second);
  second.emit(usage("two"));
  assert.equal(next.state.total.calls, 1);
  assert.equal(collector.state.total.calls, 1);
  collector.stop();
  first.emit(usage("after-stop"));
  assert.equal(collector.state.total.calls, 1);
  const fresh = await collect(first);
  assert.equal(fresh.state.total.calls, 0);
  fresh.stop();
  next.stop();
});

test("live switch during model snapshot query wins; usage is collected during startup", async () => {
  let finish;
  const source = session("race", () => new Promise((done) => { finish = done; }));
  const pending = collect(source);
  source.emit(usage("during-query"));
  source.emit({ id: "switch", type: "session.model_change", data: { newModel: "new-model" } });
  finish({ modelId: "old-model" });
  const collector = await pending;
  assert.equal(collector.state.currentModel, "new-model");
  assert.equal(collector.state.total.calls, 1);
  collector.stop();
});

test("latest model query wins over an older query and child switches do not replace selection", async () => {
  const source = session();
  const collector = await collect(source);
  const pending = [];
  source.rpc.model.getCurrent = () => new Promise((done) => pending.push(done));
  const older = collector.refreshModel();
  const newer = collector.refreshModel();
  source.emit({ id: "child", type: "session.model_change", agentId: "child", data: { newModel: "child-model" } });
  pending[1]({ modelId: "newer" });
  await newer;
  pending[0]({ modelId: "older" });
  await older;
  assert.equal(collector.state.currentModel, "newer");
  collector.stop();
});

test("absent model API is explicit and does not stop collection", async () => {
  const source = session();
  source.rpc = {};
  const collector = await collect(source);
  assert.equal(collector.state.currentModel, null);
  assert.match(collector.state.modelWarning, /unavailable/);
  source.emit(usage("a"));
  assert.equal(collector.state.total.calls, 1);
  source.rpc = { model: { getCurrent: async () => ({ modelId: "recovered" }) } };
  await collector.refreshModel();
  assert.equal(collector.state.currentModel, "recovered");
  assert.equal(collector.state.modelWarning, null);
  collector.stop();
});
