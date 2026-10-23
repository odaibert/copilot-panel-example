import { collect } from "./collector.mjs";

const safe = (value) => String(value ?? "unknown").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const count = (value) => value.toLocaleString("en-US");
const usage = (row) => `${count(row.input)} in / ${count(row.output)} out (${count(row.calls)} calls)`;

export function snapshot(state) {
  const lines = [
    "ODAIBERT DASHBOARD — snapshot",
    `Current model: ${safe(state.currentModel)}`,
    `Last main call: ${safe(state.lastRootModel)}`,
    ...(state.modelWarning ? [state.modelWarning] : []),
    "",
    `Observed total: ${usage(state.total)}`,
    `Cache read: ${count(state.total.cacheRead)} / write: ${count(state.total.cacheWrite)} (separate; not added to input)`,
    ...(state.total.missing ? [`WARNING: Incomplete input/output counts in ${count(state.total.missing)} calls; missing fields contribute zero.`] : []),
    "",
    "PER MODEL",
  ];
  const models = Object.entries(state.models);
  if (!models.length) lines.push("No model calls observed.");
  for (const [model, row] of models) lines.push(`${safe(model)}: ${usage(row)}`);
  lines.push("", "ATTRIBUTION", `Main: ${usage(state.root)}`,
    `Other classified work: ${usage(state.other)}`,
    `Subagent (no ID): ${usage(state.unknownSubagent)}`, "", "OBSERVED SUBAGENTS");
  const agents = Object.values(state.agents);
  if (!agents.length) lines.push("No attributed subagent events observed.");
  for (const row of agents) {
    lines.push(`${safe(row.id)} — ${safe(row.status)} — ${safe(row.model)}`,
      `  ${usage(row.usage)}`);
    if (row.reportedTotal !== null) {
      lines.push(`  Lifecycle reported total: ${count(row.reportedTotal)} (not added; no input/output split)`);
    }
  }
  lines.push("", "Observed since this extension attached to the foreground session only.",
    "Counters reset on extension reload/session switch/restart. Earlier or missed usage cannot be recovered.",
    "Snapshot only, not the live /tasks panel. Reopen /odaibert-dashboard to refresh.",
    "Enter accepts/closes; Esc cancels; Ctrl-d declines. All simply dismiss this snapshot.");
  return lines.join("\n");
}

export function startDashboard(joinSession) {
  const command = {
    name: "odaibert-dashboard",
    description: "Show a native snapshot of observed model and token usage",
    async handler() {
      const { session, collector } = await ready;
      if (!session.capabilities?.ui?.elicitation || typeof session.ui?.elicitation !== "function") {
        throw new Error("/odaibert-dashboard requires a Copilot CLI host with native elicitation dialogs.");
      }
      await collector.refreshModel();
      try {
        await session.ui.elicitation({
          message: snapshot(collector.state),
          requestedSchema: { type: "object", properties: {} },
        });
      } catch (error) {
        throw new Error("/odaibert-dashboard could not open the native snapshot dialog.", { cause: error });
      }
    },
  };
  const ready = (async () => {
    const session = await joinSession({ commands: [command] });
    return { session, collector: await collect(session) };
  })();
  return ready;
}
