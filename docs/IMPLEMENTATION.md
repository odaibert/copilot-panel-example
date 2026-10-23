# Building `/odaibert-dashboard`

This walkthrough explains the working source in this repository. It teaches how
to add a slash command to GitHub Copilot CLI, collect observed usage, and open a
native dialog without asking a model to generate the result.

## 1. Understand the UI boundary

The built-in `/tasks` command belongs to Copilot's terminal interface. The SDK
used here does not expose its custom panel renderer to plugins. Instead, this
example uses a supported native elicitation dialog with a message and no input
fields. It is a **snapshot**, not a continuously updating `/tasks` panel or a
right-side sidebar.

No tmux, browser, external packages, or global plugin installation is required.
You need an existing Node.js 22+ installation and an authenticated Copilot CLI
whose extension API supports commands and elicitation. The implementation was
checked against the SDK bundled with CLI 1.0.103. These APIs can change; check
your installed SDK before adapting this example.

## 2. Follow the files

| File | Responsibility |
| --- | --- |
| [`plugin.json`](../plugin.json) | Tell Copilot where the plugin's extensions live. |
| [`extensions/token-usage/extension.mjs`](../extensions/token-usage/extension.mjs) | Join the foreground session and handle shutdown. |
| [`lib/dashboard.mjs`](../lib/dashboard.mjs) | Register the command, format a snapshot, and request the dialog. |
| [`lib/collector.mjs`](../lib/collector.mjs) | Subscribe to events and refresh the current model safely. |
| [`lib/metrics.mjs`](../lib/metrics.mjs) | Aggregate usage and attribute calls without UI or SDK dependencies. |
| [`bin/launch.mjs`](../bin/launch.mjs) | Optional convenience launcher for `npm start`. |
| [`test/`](../test/) | Exercise accounting, collection, commands, and launcher behavior. |

The runtime path is:

```text
Copilot loads plugin.json
  -> starts extension.mjs
  -> joinSession({ commands })
  -> collector observes foreground-session events
  -> user runs /odaibert-dashboard
  -> command refreshes model selection
  -> snapshot(state) formats observed counters
  -> session.ui.elicitation(...) opens the native dialog
```

## 3. Make the extension discoverable

The root manifest declares the extension directory:

```json
{
  "name": "token-usage",
  "version": "1.0.0",
  "description": "Observed token usage in a native Copilot CLI snapshot dialog",
  "author": { "name": "odaibert" },
  "extensions": ["./extensions"]
}
```

Each extension has its own subdirectory containing `extension.mjs`. Load the
local plugin from the repository root:

```sh
copilot --plugin-dir "$PWD"
```

This is the Copilot-specific legacy manifest format. Do not add a different
plugin `$schema` and assume its `extensions` field has the same meaning.
See the [CLI plugin reference](https://docs.github.com/en/copilot/reference/cli-plugin-reference).

## 4. Attach to the existing session

The extension imports `joinSession` from `@github/copilot-sdk/extension`. Copilot
resolves this module when it launches the extension; there is no SDK dependency
to install into this project.

Extensions run in a separate process and use standard input/output for JSON-RPC.
Do **not** use `console.log()` to render the dashboard: writing to extension
stdout can corrupt that protocol. Ask the host to display UI instead.

The entry point delegates to `startDashboard(joinSession)` and unregisters the
collector on shutdown. Passing `joinSession` as an argument also lets tests
provide a fake host without launching Copilot.

## 5. Register the exact command name

In `lib/dashboard.mjs`, `startDashboard` supplies a command definition to
`joinSession`:

```js
const command = {
  name: "odaibert-dashboard",
  description: "Show a native snapshot of observed model and token usage",
  async handler() {
    // Read collected state and request the native dialog.
  },
};
```

The registered name has **no leading slash**. Copilot exposes it to the user as
`/odaibert-dashboard`.

The real handler awaits the initialization promise named `ready`, so it cannot
use an uninitialized session or collector. No prompt is sent to the model when
the command runs; formatting and accounting are ordinary JavaScript.

## 6. Collect events before querying the model

`collect(session)` creates fresh in-memory counters and subscribes through
`session.on(...)` **before** querying `session.rpc.model.getCurrent()`.

Why that order? A model can change while the initial query is in flight.
Subscribing first lets the collector see that change. A revision counter prevents
the older query response from overwriting the newer selection. A separate query
sequence ensures an older concurrent refresh cannot override a newer refresh.
Subagent model-change events do not replace the main session's selection.

The UI distinguishes:

- **Current model:** the selected model, possibly `auto`.
- **Last main call:** the concrete model from the most recent observed main call.
- **Per-model usage:** the model reported by each usage event.

These are different facts. A subagent may use a different model, and changing the
selection does not retroactively move usage between model totals.

## 7. Aggregate usage without inventing it

`applyEvent(state, event)` in `lib/metrics.mjs` is the accounting boundary. It
accepts supported events, ignores duplicate event IDs, and updates counters.

| Event | Use |
| --- | --- |
| `assistant.usage` | Add observed per-call input, output, cache, and model counts. |
| `session.model_change` | Update selection for a main-session change. |
| `subagent.started` / `subagent.configured` | Track observed agent identity, model, and status. |
| `subagent.completed` / `subagent.failed` | Update status and any separately reported lifecycle total. |

Important invariants:

- Cache read/write counts are displayed separately, not added again to input.
- Lifecycle `totalTokens` is not added to usage-event counters; doing so could
  count the same work twice.
- Missing or invalid input/output counters contribute zero **and** trigger an
  incomplete-count warning. Zero is not represented as a verified complete count.
- Attribution uses `agentId` or the legacy `parentToolCallId`. Classified subagent
  work without identity remains explicitly unattributed.
- An event's `parentId` is not used as a subagent identity.
- Late identity mappings merge related agent counters instead of displaying
  the same agent's observed work as unrelated rows.
- Externally supplied model/agent keys are handled as own properties, including
  names such as `__proto__`.

The state keeps counters and necessary identity metadata, not prompt text, tool
arguments, or tool results. Display strings have control characters removed.

## 8. Open the host's native dialog

After checking `session.capabilities.ui.elicitation`, the handler refreshes the
selection and makes this request:

```js
await session.ui.elicitation({
  message: snapshot(collector.state),
  requestedSchema: { type: "object", properties: {} },
});
```

The empty object schema creates no editable fields in the targeted CLI's form
renderer. The message carries the dashboard. Dismissing the dialog does not
change counters. Unsupported UI and transport failures become command errors,
not a fake successful response or an unexpected model request.

The snapshot is formatted when the command is invoked. Events may continue to
arrive, but they do not update the already-open message. Close and reopen
`/odaibert-dashboard` for a fresh snapshot.

## 9. State the limits honestly

Usage events are ephemeral in the targeted SDK. This example cannot reconstruct
calls made before attachment, during a reload gap, or in another session.
Counters reset when the extension restarts or the foreground session changes.
Resuming a conversation does not restore this extension's previous counters.

These are **observed API-call token totals**, not context occupancy, credit
charges, monetary cost, remaining allowance, or lifetime conversation usage.
Only subagent events actually forwarded to this collector can be included.

## 10. Run and verify

From the repository root:

```sh
npm test
npm run check
copilot --plugin-dir "$PWD" plugin list --json
copilot --plugin-dir "$PWD"
```

Inside Copilot, trust the local plugin if prompted, make a normal request, then
run `/odaibert-dashboard`. Reopen after another request to see new observations.
If the command is missing, inspect `/env` and the extension's status.

The ordinary tests use fake sessions and require no model calls. The optional
SDK smoke tests use the actual installed SDK with a simulated JSON-RPC host:

```sh
COPILOT_USAGE_SDK_PATH=/absolute/path/to/copilot-sdk/extension.js \
  node --test test/sdk.test.mjs
```

These verify command registration, command execution, dialog payloads, and
unsupported-host errors. They do not visually verify the interactive renderer.
Locate the SDK bundled with your own CLI instead of copying a machine-specific
path.

For learning, start with `test/dashboard.test.mjs`: emit a synthetic usage event,
invoke the registered handler, and inspect the dialog message. Then read
`test/collector.test.mjs` for model-query races and `test/metrics.test.mjs` for
attribution and accounting edge cases. To add a metric, update the accounting
boundary, add a focused behavior test, and only then expose it in `snapshot()`.
