import { joinSession } from "@github/copilot-sdk/extension";
import { startDashboard } from "../../lib/dashboard.mjs";

try {
  const { collector } = await startDashboard(joinSession);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      collector.stop();
      process.exit(0);
    });
  }
  process.once("exit", () => collector.stop());
} catch {
  process.stderr.write("token-usage: native dashboard extension could not start.\n");
  process.exitCode = 1;
}
