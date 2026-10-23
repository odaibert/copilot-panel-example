import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@github/copilot-sdk/extension") {
    return { url: pathToFileURL(process.env.COPILOT_USAGE_SDK_PATH).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
