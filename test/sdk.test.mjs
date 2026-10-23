import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdk = process.env.COPILOT_USAGE_SDK_PATH;

async function simulate(t, supported) {
  const extension = pathToFileURL(resolve("extensions/token-usage/extension.mjs")).href;
  const loader = pathToFileURL(resolve("test/fixtures/sdk-loader.mjs")).href;
  const env = { ...process.env, SESSION_ID: "sdk-smoke" };
  delete env.COPILOT_USAGE_RUN_DIR;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { register } from "node:module"; register(${JSON.stringify(loader)}, import.meta.url);
await import(${JSON.stringify(extension)});`], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  let stderr = "";
  let buffer = Buffer.alloc(0);
  const requests = [];
  let resolveCommand;
  let rejectCommand;
  const complete = new Promise((done, reject) => { resolveCommand = done; rejectCommand = reject; });
  const timer = setTimeout(() => rejectCommand(new Error(
    `RPC timeout; requests: ${requests.map((row) => row.method).join(", ")}; stderr: ${stderr}`,
  )), 6000);
  t.after(() => clearTimeout(timer));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", rejectCommand);
  function send(value) {
    const body = Buffer.from(JSON.stringify(value));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  function notification(event) {
    send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "sdk-smoke", event } });
  }
  let queried = false;
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (true) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString());
        if (!match) throw new Error("Invalid RPC stdout");
        const length = Number(match[1]);
        if (buffer.length < end + 4 + length) return;
        const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
        buffer = buffer.subarray(end + 4 + length);
        requests.push(request);
        const respond = (result) => send({ jsonrpc: "2.0", id: request.id, result });
        if (request.method === "connect") {
          respond({ protocolVersion: 3 });
        } else if (request.method === "session.resume") {
          respond({ sessionId: "sdk-smoke", capabilities: { ui: { elicitation: supported } } });
        } else if (request.method === "session.model.getCurrent") {
          respond({ modelId: queried ? "switched-model" : "sdk-model" });
          if (!queried) {
            queried = true;
            setTimeout(() => {
              const usage = { id: "sdk-call", type: "assistant.usage", ephemeral: true,
                parentId: null, timestamp: new Date().toISOString(), agentId: "child-1",
                data: { model: "actual-child", inputTokens: 42, outputTokens: 7, cacheReadTokens: 30 } };
              notification(usage);
              notification(usage);
              notification({ id: "main-call", type: "assistant.usage",
                data: { model: "actual-main", inputTokens: 10, outputTokens: 3 } });
              notification({ id: "sdk-switch", type: "session.model_change", data: { newModel: "switched-model" } });
              notification({ id: "execute", type: "command.execute", data: {
                requestId: "dashboard-request", commandName: "odaibert-dashboard",
                command: "/odaibert-dashboard", args: "",
              } });
            }, 30);
          }
        } else if (request.method === "session.ui.elicitation") {
          respond({ action: "accept", content: {} });
        } else if (request.method === "session.commands.handlePendingCommand") {
          respond({});
          resolveCommand(request.params);
        } else if (request.id !== undefined) {
          send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unexpected: ${request.method}` } });
          rejectCommand(new Error(`Unexpected RPC request: ${request.method}`));
        }
      }
    } catch (error) { rejectCommand(error); }
  });
  const result = await complete;
  clearTimeout(timer);
  assert.deepEqual(requests.find((row) => row.method === "session.resume").params.commands, [{
    name: "odaibert-dashboard", description: "Show a native snapshot of observed model and token usage",
  }]);
  assert.equal(requests.some((row) => row.method === "session.send" || row.method?.includes("model.send")), false);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  return { requests, result };
}

test("installed SDK registers and executes /odaibert-dashboard over JSON-RPC with a native dialog, no model calls", {
  skip: !sdk && "Set COPILOT_USAGE_SDK_PATH to installed copilot-sdk/extension.js",
  timeout: 10_000,
}, async (t) => {
  const { requests, result } = await simulate(t, true);
  assert.equal(result.requestId, "dashboard-request");
  assert.equal(result.error, undefined);
  const payload = requests.find((row) => row.method === "session.ui.elicitation").params;
  assert.equal(payload.sessionId, "sdk-smoke");
  assert.deepEqual(payload.requestedSchema, { type: "object", properties: {} });
  assert.match(payload.message, /Current model: switched-model/);
  assert.match(payload.message, /Last main call: actual-main/);
  assert.match(payload.message, /Observed total: 52 in \/ 10 out \(2 calls\)/);
  assert.match(payload.message, /actual-child: 42 in \/ 7 out/);
  assert.match(payload.message, /actual-main: 10 in \/ 3 out/);
  assert.match(payload.message, /child-1 — observed — actual-child/);
  assert.match(payload.message, /Cache read: 30 \/ write: 0/);
});

test("installed SDK returns a standard command error if host native dialogs are unsupported", {
  skip: !sdk && "Set COPILOT_USAGE_SDK_PATH to installed copilot-sdk/extension.js",
  timeout: 10_000,
}, async (t) => {
  const { requests, result } = await simulate(t, false);
  assert.match(result.error, /requires a Copilot CLI host with native elicitation/);
  assert.equal(requests.some((row) => row.method === "session.ui.elicitation"), false);
});
