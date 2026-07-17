// ESM loader hook that lets the tests run the real extension unmodified.
//
// extension.mjs does `import { joinSession } from "@github/copilot-sdk/extension"`,
// which only exists inside the installed Copilot CLI. During tests we intercept
// that bare specifier and resolve it to ./sdk-mock.mjs instead, so no copy of the
// extension and no node_modules shim is needed.
//
// Run with:  node --experimental-loader ./test/sdk-loader.mjs ./test/run.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mockUrl = pathToFileURL(join(here, "sdk-mock.mjs")).href;

export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: mockUrl, shortCircuit: true };
    }
    return next(specifier, context);
}
