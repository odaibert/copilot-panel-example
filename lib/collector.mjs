import { applyEvent, createMetrics, setCurrentModel } from "./metrics.mjs";

export async function collect(session) {
  const state = createMetrics(session.sessionId);
  let revision = 0;
  let query = 0;
  const unsubscribe = session.on((event) => {
    if (applyEvent(state, event) && event.type === "session.model_change" && !event.agentId) {
      revision++;
    }
  });
  async function refreshModel() {
    const started = revision;
    const request = ++query;
    try {
      const model = await session.rpc.model.getCurrent();
      if (request !== query || started !== revision) return;
      setCurrentModel(state, model.modelId);
      state.modelWarning = state.currentModel ? null : "The host returned no current model.";
    } catch {
      if (request === query) {
        state.modelWarning = "Current model query unavailable; showing the last observed selection, or unknown.";
      }
    }
  }
  // Subscribe before querying so a live switch wins over a stale snapshot.
  await refreshModel();
  return { state, refreshModel, stop: unsubscribe };
}
