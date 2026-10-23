import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(".");
const launcher = join(root, "bin/launch.mjs");
function fixtures(t) {
  const dir = resolve(".test-runs", randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copilot = join(dir, "copilot");
  const log = join(dir, "child.json");
  writeFileSync(copilot, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_CHILD, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  usageDirectory: process.env.COPILOT_USAGE_RUN_DIR ?? null
}));
process.exit(Number(process.env.TEST_EXIT ?? 0));
`, { mode: 0o700 });
  const env = { ...process.env, PATH: dir, COPILOT_USAGE_COPILOT: copilot, TEST_CHILD: log };
  delete env.COPILOT_USAGE_RUN_DIR;
  return { dir, log, env };
}

test("launcher mounts plugin from arbitrary CWD and passes literal arguments without extra programs", (t) => {
  const f = fixtures(t);
  const args = ["--model", "model name", "--resume", "id'$(touch should-not-exist)", "-C", "path with spaces"];
  const result = spawnSync(process.execPath, [launcher, "--", ...args], {
    env: f.env, cwd: f.dir, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(readFileSync(f.log, "utf8"));
  assert.deepEqual(child, { args: ["--plugin-dir", root, ...args], cwd: f.dir, usageDirectory: null });
});

test("launcher forwards Copilot help and nonzero exit codes", (t) => {
  const f = fixtures(t);
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    env: { ...f.env, TEST_EXIT: "7" }, encoding: "utf8",
  });
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(readFileSync(f.log, "utf8")).args, ["--plugin-dir", root, "--help"]);
});

test("missing Copilot executable produces an actionable error", (t) => {
  const f = fixtures(t);
  const result = spawnSync(process.execPath, [launcher], {
    env: { ...f.env, COPILOT_USAGE_COPILOT: join(f.dir, "missing") }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot start Copilot CLI/);
});
