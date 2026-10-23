# Copilot panel example

An educational Copilot CLI extension. Run **`/odaibert-dashboard`** to see the
current model, observed token totals, per-model usage, and subagent activity in a
native snapshot dialog. No extra packages or terminal tools.

![Native dashboard with observed model and token usage](docs/images/dashboard-usage.png)

## Run

Requires Node.js 22+ and Copilot CLI with extension commands and native dialogs
(verified with CLI 1.0.103).

```sh
git clone https://github.com/odaibert/copilot-panel-example.git
cd copilot-panel-example
copilot --plugin-dir "$PWD"
```

Then, inside Copilot:

```text
/odaibert-dashboard
```

Trust/enable the plugin if prompted. No `npm install` is needed.
Press Enter or Esc to close; reopen the command to refresh.
If the command is missing, check `/env` and the extension status.

## Limits

This uses a native elicitation dialog, **not the live `/tasks` panel**. Counters
cover events observed since attachment and reset on reload, session switch, or
restart. Earlier usage cannot be recovered.

Cache counts are separate from input; attribution depends on host metadata.
These are API-call tokens, not costs, credits, or context occupancy. No prompts
or transcripts are collected, and opening the dashboard makes no model request.

## Learn and develop

Read the [implementation walkthrough](docs/IMPLEMENTATION.md) for the architecture,
accounting rules, SDK tests, and
[real screenshot reproduction steps](docs/IMPLEMENTATION.md#11-reproduce-the-screenshots).

```sh
npm test
npm run check
```
