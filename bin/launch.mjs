import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const child = spawn(process.env.COPILOT_USAGE_COPILOT ?? "copilot",
  ["--plugin-dir", root, ...(args[0] === "--" ? args.slice(1) : args)],
  { stdio: "inherit" });
let failed = false;
const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
  const handler = () => child.kill(signal);
  process.on(signal, handler);
  return [signal, handler];
}));
child.once("error", (error) => {
  failed = true;
  process.stderr.write(`token-usage: cannot start Copilot CLI: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler);
  if (failed) return;
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
