// Minimal mock of `@github/copilot-sdk/extension` for tests.
//
// The extension calls joinSession(config) once at import time and keeps the
// returned session object. We stash the registered tools/commands/hooks on a
// global so the test runner can drive them, and return the test-controlled
// session that the runner set up beforehand (globalThis.__pins.session).
export async function joinSession(config) {
    const g = (globalThis.__pins ??= {});
    g.tools = config.tools;
    g.commands = config.commands;
    g.hooks = config.hooks;
    return g.session;
}
