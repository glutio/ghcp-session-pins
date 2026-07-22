// Persistent test suite for the session-pins extension.
//
// Runs the REAL extension.mjs (via test/sdk-loader.mjs, which mocks the Copilot
// SDK) and drives its tools and prompt hook against throwaway temp session
// folders. Covers the behaviours that past code review flagged:
//   1. Consent gates on model-initiated pins
//   2. XML escaping of injected content + attributes
//   3. Dropping malformed pins on load (no crash)
//   4. Durable atomic saves (valid, complete pins.json; no temp litter)
//
// Run:  npm test   (from the plugin folder)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const state = {
    sessionRoot: null,
    elicitation: true,
    confirmReturn: true,
    confirmCalls: [],
    logs: [],
    sentMessages: [],
    // Queue of responders for the interactive picker (choose -> session.ui.elicitation).
    // Each responder gets (message, options) and returns the option to pick, or null.
    // When the queue is exhausted, the picker is cancelled (returns null).
    elicitResponders: [],
};

globalThis.__pins = {
    session: {
        sessionId: "test-session",
        get workspacePath() { return state.noWorkspace ? undefined : state.sessionRoot; },
        get capabilities() { return { ui: state.elicitation ? { elicitation: true } : {} }; },
        ui: {
            async confirm(message) { state.confirmCalls.push(message); return state.confirmReturn; },
            async select() { return null; },
            async input() { return null; },
            async elicitation({ message, requestedSchema }) {
                const options = (requestedSchema?.properties?.selection?.oneOf ?? []).map((o) => o.const);
                const responder = state.elicitResponders.shift();
                const selection = responder ? responder(message, options) : null;
                return selection == null
                    ? { action: "cancel" }
                    : { action: "accept", content: { selection } };
            },
        },
        async log(message) { state.logs.push(message); },
        async send(prompt) { state.sentMessages.push(prompt); return "mock-message-id"; },
    },
};

// Seed a session with pins BEFORE loading the extension so its one-time startup
// pin-count notice fires against a known store and can be asserted below.
state.sessionRoot = mkdtempSync(join(tmpdir(), "pinstartup-"));
mkdirSync(join(state.sessionRoot, "files"), { recursive: true });
writeFileSync(join(state.sessionRoot, "pins.json"), JSON.stringify({ version: 1, pins: [
    { id: "s1", type: "prompt", text: "startup rule", enabled: true },
    { id: "s2", type: "prompt", text: "silenced", enabled: false },
] }));

// Import the real extension (loader maps the SDK specifier to sdk-mock.mjs).
await import(new URL("../extensions/session-pins/extension.mjs", import.meta.url));
const startupLogs = [...state.logs];
const { tools, hooks } = globalThis.__pins;
const tool = Object.fromEntries(tools.map((t) => [t.name, t]));
const inv = { sessionId: "test-session" };

let passed = 0;
let failed = 0;
function check(name, condition) {
    if (condition) {
        passed++;
        console.log("  \u2713", name);
    } else {
        failed++;
        console.log("  \u2717 FAIL:", name);
    }
}
function group(name) { console.log("\n" + name); }

function freshSession() {
    // Clean up the previous throwaway session dir so the suite doesn't leave a
    // trail of pinsess-*/pinstartup-* dirs under the OS temp folder.
    if (state.sessionRoot) {
        try { rmSync(state.sessionRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    state.sessionRoot = mkdtempSync(join(tmpdir(), "pinsess-"));
    mkdirSync(join(state.sessionRoot, "files"), { recursive: true });
    state.confirmCalls.length = 0;
    state.logs.length = 0;
    state.sentMessages.length = 0;
    state.elicitResponders.length = 0;
    state.noWorkspace = false;
    return state.sessionRoot;
}
function readPins() {
    const file = join(state.sessionRoot, "pins.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).pins : [];
}
function seedPins(pins) {
    writeFileSync(join(state.sessionRoot, "pins.json"), JSON.stringify({ version: 1, pins }));
}
async function render() {
    return (await hooks.onUserPromptSubmitted({}, inv))?.additionalContext ?? "";
}

// ---------------------------------------------------------------------------
group("Startup pin-count notice");
{
    check("startup notice reports active + disabled counts",
        startupLogs.some((m) => /1 pin active \(1 disabled\)/.test(m)));
    check("startup notice points to /pin",
        startupLogs.some((m) => /session-pins:.*\/pin/.test(m)));
}

// ---------------------------------------------------------------------------
group("Consent gates (model-initiated pins)");
{
    // pin_prompt: approve
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    let out = await tool.pin_prompt.handler({ text: "always run tests" }, inv);
    check("pin_prompt asks for confirmation", state.confirmCalls.length === 1);
    check("pin_prompt (approved) persists the pin", readPins().some((p) => p.text === "always run tests"));
    check("pin_prompt (approved) uses unified voice", /^Pinned pin 1: "always run tests"\.$/.test(out));

    // pin_prompt: decline
    freshSession();
    state.confirmReturn = false;
    out = await tool.pin_prompt.handler({ text: "sneaky" }, inv);
    check("pin_prompt (declined) does not pin", readPins().length === 0);
    check("pin_prompt (declined) says so", /declined/i.test(out));

    // pin_prompt: no elicitation UI -> refuse, never persist
    freshSession();
    state.elicitation = false;
    out = await tool.pin_prompt.handler({ text: "no ui" }, inv);
    check("pin_prompt (no UI) refuses without asking", state.confirmCalls.length === 0 && /confirmation/i.test(out));
    check("pin_prompt (no UI) does not pin", readPins().length === 0);

    // pin_file: approve (even for an in-context file under <session>/files)
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "note.md"), "hello");
    out = await tool.pin_file.handler({ path: "note.md" }, inv);
    check("pin_file asks for confirmation", state.confirmCalls.length === 1);
    check("pin_file confirm prompt discloses the file size + per-turn cost", /\bB\b|KB|MB/.test(state.confirmCalls[0]) && /every prompt/i.test(state.confirmCalls[0]));
    check("pin_file (approved) persists the pin", readPins().some((p) => p.type === "file"));
    check("pin_file (approved) uses unified voice (@path)", /^Pinned pin 1: /.test(out) && out.includes("@note.md"));

    // pin_file: decline
    freshSession();
    state.confirmReturn = false;
    writeFileSync(join(state.sessionRoot, "files", "note.md"), "hello");
    out = await tool.pin_file.handler({ path: "note.md" }, inv);
    check("pin_file (declined) does not pin", readPins().length === 0);

    // pin_file: no UI -> refuse
    freshSession();
    state.elicitation = false;
    writeFileSync(join(state.sessionRoot, "files", "note.md"), "hello");
    out = await tool.pin_file.handler({ path: "note.md" }, inv);
    check("pin_file (no UI) refuses without asking", state.confirmCalls.length === 0 && /confirmation/i.test(out));

    // pin_file: optimistic pin of a not-yet-existing file. Models often issue the
    // file-creating tool call and pin_file as parallel tool calls in one turn; the
    // runtime runs them concurrently, so pin_file's stat can execute before the
    // create's write lands. Rather than fail or wait, pin_file pins optimistically,
    // reports the file isn't there yet, and the pin is flagged "(not found)" until
    // the file exists (which, for a concurrent create, is the very next prompt).
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    out = await tool.pin_file.handler({ path: "not-created-yet.md" }, inv);
    check("pin_file pins a not-yet-existing file (optimistic, no wait)", readPins().some((p) => p.type === "file"));
    check("pin_file (missing) tells the model the file isn't there yet", /not found|doesn't exist/i.test(out));
    check("pin_file (missing) still uses the @path voice", out.includes("@not-created-yet.md"));
    check("pin_file (missing) does not leak the absolute session path", !out.includes(state.sessionRoot));

    // Once the file exists, the same path pins normally with a size note, no warning.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "real.md"), "hello");
    out = await tool.pin_file.handler({ path: "real.md" }, inv);
    check("pin_file (existing) pins without a not-found warning", readPins().length === 1 && !/not found|doesn't exist/i.test(out));
    check("pin_file (existing) confirm prompt shows a size, not a not-found note", /\bB\b|KB|MB/.test(state.confirmCalls[0]) && !/not found/i.test(state.confirmCalls[0]));
}

// ---------------------------------------------------------------------------
group("XML escaping + malformed-pin handling (prompt hook)");
{
    freshSession();
    state.elicitation = true;
    // '&' is legal in a Windows filename and must be escaped in the path attribute.
    const ampName = "a & b.md";
    writeFileSync(join(state.sessionRoot, "files", ampName), 'content with <tag> & "quote"');
    // An unreadable pin whose stored (absolute) path has " < > ' & exercises the
    // catch branch + attribute escaping without needing such a file to exist.
    const trickyAbs = "C:\\no\\such\\weird\" <x> 'y' & z.md";
    const pinsJson = {
        version: 1,
        pins: [
            { id: "p1", type: "prompt", text: "valid prompt <b>&</b>" },
            { id: "f1", type: "file", path: ampName },
            { id: "f2", type: "file", path: trickyAbs },
            { id: "bad1", type: "file", path: 123 },   // non-string path -> drop
            { id: "bad2", type: "file" },              // no path -> drop
            { type: "prompt", text: "no id" },         // no id -> drop
            { id: "bad3", type: "prompt" },            // no text -> drop
            { id: "bad4", type: "unknown" },           // bad type -> drop
            null, "string",                            // not objects -> drop
        ],
    };
    writeFileSync(join(state.sessionRoot, "pins.json"), JSON.stringify(pinsJson));

    let out = "";
    let threw = false;
    try { out = (await hooks.onUserPromptSubmitted({}, inv))?.additionalContext ?? ""; }
    catch { threw = true; }

    check("hook does not throw on a partially-corrupt pins.json", !threw);
    check("valid prompt text is rendered", out.includes("valid prompt"));
    check("prompt content angle brackets escaped", out.includes("&lt;b&gt;"));
    check("readable file content is rendered", out.includes("content with"));
    check("file content angle brackets escaped", out.includes("&lt;tag&gt;"));
    check("'&' in path attribute is escaped", out.includes("a &amp; b.md"));
    check("'\"' in path attribute is escaped", out.includes("&quot;"));
    check("''' in path attribute is escaped", out.includes("&apos;"));
    check("'<>' in path attribute is escaped", out.includes("&lt;x&gt;"));
    check("no raw quote breaks the path attribute", !out.includes('weird" <x>'));
    check("exactly one prompt-pin survives", (out.match(/<prompt_pin /g) || []).length === 1);
    check("exactly two file-pins survive", (out.match(/<live_file_pin /g) || []).length === 2);
    check("injected pins are numbered, not guid-identified", /<prompt_pin number="\d+">/.test(out) && !/ id=/.test(out));
    check("dropped-pins warning is logged", state.logs.some((m) => /dropped 7 malformed/.test(m)));
    // Session-rooted pins must expose only their relative/display path — never the
    // absolute session path (which would leak the home dir / username every turn).
    check("session-rooted path is not leaked as absolute", !out.includes(state.sessionRoot));
    check("session-rooted path shown relative in attribute", out.includes('path="a &amp; b.md"'));

    // An unreadable session-rooted pin must not leak the absolute path via the
    // error text (fs error messages embed it) — only an error code is emitted.
    freshSession();
    seedPins([{ id: "missing", type: "file", path: "does-not-exist.md" }]);
    const outMissing = await render();
    check("unreadable pin reports it could not be read", /could not be read/.test(outMissing));
    check("unreadable pin emits an error code, not a message", /error code \w+/.test(outMissing));
    check("unreadable pin does not leak the absolute session path", !outMissing.includes(state.sessionRoot));
    // The every-turn preamble must tell the agent to consider pins as a possible
    // cause when debugging, and to surface (not silently ignore) a conflicting pin.
    check("preamble frames pins as active instructions", /treat it as active instructions/i.test(out));
}

// ---------------------------------------------------------------------------
group("Non-interactive host (no elicitation UI)");
{
    const runPin = globalThis.__pins.commands.find((c) => c.name === "pin").handler;

    // /pin add with no inline text must not throw when there's no UI to prompt.
    freshSession();
    state.elicitation = false;
    let threw = false;
    try { await runPin({ args: "add", sessionId: inv.sessionId }); } catch { threw = true; }
    check("/pin add (no UI, no text) does not throw", !threw);
    check("/pin add (no UI) pins nothing", readPins().length === 0);
    check("/pin add (no UI) explains the inline form", state.logs.some((m) => /inline/i.test(m)));

    // /pin edit <n> must not throw when there's no UI (editing needs a prompt).
    freshSession();
    state.elicitation = false;
    writeFileSync(join(state.sessionRoot, "pins.json"), JSON.stringify({ version: 1, pins: [{ id: "e1", type: "prompt", text: "editable" }] }));
    threw = false;
    try { await runPin({ args: "edit 1", sessionId: inv.sessionId }); } catch { threw = true; }
    check("/pin edit N (no UI) does not throw", !threw);
    check("/pin edit N (no UI) leaves the pin intact", readPins().some((p) => p.text === "editable"));
    check("/pin edit N (no UI) explains it needs a prompt", state.logs.some((m) => /interactive prompt/i.test(m)));
}

// ---------------------------------------------------------------------------
group("Concurrent first-load coalescing");
{
    // Seed a store on disk, then fire two adds concurrently. Both hit a fresh
    // (uncached) session, so without load coalescing they would each parse the
    // file into a separate store object and one add would be lost on save.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "pins.json"), JSON.stringify({ version: 1, pins: [{ id: "o1", type: "prompt", text: "original" }] }));
    await Promise.all([
        tool.pin_prompt.handler({ text: "concurrent-X" }, inv),
        tool.pin_prompt.handler({ text: "concurrent-Y" }, inv),
    ]);
    const pins = readPins();
    check("original pin is preserved", pins.some((p) => p.text === "original"));
    check("both concurrent adds are preserved", ["concurrent-X", "concurrent-Y"].every((t) => pins.some((p) => p.text === t)));
}

// ---------------------------------------------------------------------------
group("Durable atomic saves");
{
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    const out = await tool.pin_prompt.handler({ text: "durable" }, inv);
    check("save produced a pins.json", existsSync(join(state.sessionRoot, "pins.json")));
    let ok = false;
    try { JSON.parse(readFileSync(join(state.sessionRoot, "pins.json"), "utf8")); ok = true; } catch {}
    check("pins.json is valid, complete JSON", ok);
    check("pins.json ends with a trailing newline", readFileSync(join(state.sessionRoot, "pins.json"), "utf8").endsWith("\n"));
    check("no leftover .tmp files after save", readdirSync(state.sessionRoot).every((f) => !f.endsWith(".tmp")));

    // Concurrent saves must serialize without corrupting the file.
    await Promise.all([
        tool.pin_prompt.handler({ text: "A" }, inv),
        tool.pin_prompt.handler({ text: "B" }, inv),
        tool.pin_prompt.handler({ text: "C" }, inv),
    ]);
    let ok2 = false;
    let pins = [];
    try { pins = JSON.parse(readFileSync(join(state.sessionRoot, "pins.json"), "utf8")).pins; ok2 = true; } catch {}
    check("concurrent saves leave valid JSON", ok2);
    check("all concurrent pins are present", ["A", "B", "C"].every((t) => pins.some((p) => p.text === t)));
}

// ---------------------------------------------------------------------------
group("Enable / disable pins");
{
    const runPin = globalThis.__pins.commands.find((c) => c.name === "pin").handler;

    // A disabled pin is kept but never injected.
    freshSession();
    seedPins([
        { id: "on1", type: "prompt", text: "active rule", enabled: true },
        { id: "off1", type: "prompt", text: "silenced rule", enabled: false },
    ]);
    let out = await render();
    check("enabled pin is injected", out.includes("active rule"));
    check("disabled pin is NOT injected", !out.includes("silenced rule"));

    // A pin with no `enabled` field is treated as enabled (backward compatible).
    freshSession();
    seedPins([{ id: "legacy", type: "prompt", text: "legacy rule" }]);
    out = await render();
    check("legacy pin (no enabled field) is injected", out.includes("legacy rule"));

    // pin_list reports the state.
    freshSession();
    seedPins([
        { id: "on1", type: "prompt", text: "active rule", enabled: true },
        { id: "off1", type: "prompt", text: "silenced rule", enabled: false },
    ]);
    const listed = await tool.pin_list.handler({}, inv);
    check("pin_list marks enabled pins", /\(enabled\) "active rule"/.test(listed));
    check("pin_list redacts disabled pin content", /\(disabled\) \[content hidden/.test(listed));
    check("pin_list does not expose disabled pin text", !listed.includes("silenced rule"));

    // pin_list must not leak the absolute session path for a session-rooted file.
    freshSession();
    writeFileSync(join(state.sessionRoot, "files", "notes.md"), "hi");
    seedPins([{ id: "sf", type: "file", path: "notes.md", enabled: true }]);
    const listedFile = await tool.pin_list.handler({}, inv);
    check("pin_list shows session file relative", listedFile.includes("`@notes.md`"));
    check("pin_list does not leak the absolute session path", !listedFile.includes(state.sessionRoot));
    check("pin_list shows the per-file size", listedFile.includes("`@notes.md` (~2 B)"));
    check("pin_list shows a running context total", /added to every prompt/.test(listedFile));

    // A path containing a backtick must render as a valid, larger-fenced code span.
    freshSession();
    writeFileSync(join(state.sessionRoot, "files", "a`b.md"), "hi");
    seedPins([{ id: "bt", type: "file", path: "a`b.md", enabled: true }]);
    const listedBt = await tool.pin_list.handler({}, inv);
    check("backtick path uses a larger fence (``@a`b.md``)", listedBt.includes("``@a`b.md``"));

    // /pin list output shows the ✓ / ✗ glyphs.
    freshSession();
    seedPins([
        { id: "on1", type: "prompt", text: "active rule", enabled: true },
        { id: "off1", type: "prompt", text: "silenced rule", enabled: false },
    ]);
    await runPin({ args: "list", sessionId: inv.sessionId });
    const listLog = state.logs.join("\n");
    check("/pin list shows filled-circle glyph for enabled", listLog.includes("\u25cf"));
    check("/pin list shows hollow-circle glyph for disabled", listLog.includes("\u25cb"));

    // /pin list shows a running byte total, and a per-file size on file pins.
    freshSession();
    writeFileSync(join(state.sessionRoot, "files", "big.md"), "x".repeat(3000));
    seedPins([
        { id: "p1", type: "prompt", text: "a rule", enabled: true },
        { id: "f1", type: "file", path: "big.md", enabled: true },
    ]);
    state.logs.length = 0;
    await runPin({ args: "list", sessionId: inv.sessionId });
    const costLog = state.logs.join("\n");
    check("/pin list shows a running context total", /added to every prompt/.test(costLog));
    check("/pin list shows a per-file size on file pins", /@big\.md \(~/.test(costLog));
    check("/pin list does not add a size to prompt pins", /"a rule"(?! \(~)/.test(costLog));

    // /pin list flags a file pin whose file doesn't exist (optimistic pin, or a
    // moved/deleted file) as "(not found)" instead of a size, and it is excluded
    // from the running byte total.
    freshSession();
    writeFileSync(join(state.sessionRoot, "files", "here.md"), "x".repeat(2048));
    seedPins([
        { id: "f1", type: "file", path: "here.md", enabled: true },
        { id: "f2", type: "file", path: "gone.md", enabled: true },   // never created
    ]);
    state.logs.length = 0;
    await runPin({ args: "list", sessionId: inv.sessionId });
    const missLog = state.logs.join("\n");
    check("/pin list flags a missing file pin as (not found)", /@gone\.md \(not found\)/.test(missLog));
    check("/pin list still sizes the present file pin", /@here\.md \(~/.test(missLog));
    check("/pin list total counts only the present file (~2 KB)", /2 KB added to every prompt/.test(missLog));

    // Pinboard toggle: pick the pin, choose Disable -> persisted + no longer
    // injected, and the dialog returns to the list so the change is visible.
    freshSession();
    state.elicitation = true;
    seedPins([{ id: "t1", type: "prompt", text: "toggle me", enabled: true }]);
    let afterToggleOptions = null;
    state.elicitResponders = [
        (_m, opts) => opts.find((o) => !o.startsWith("+")), // select the pin in the list
        (_m, opts) => opts.find((o) => /Disable/.test(o)),  // choose Disable in the detail
        (_m, opts) => { afterToggleOptions = opts.slice(); return null; }, // next call should be the list
    ];
    await runPin({ args: "", sessionId: inv.sessionId });
    check("pinboard toggle persisted enabled:false", readPins().find((p) => p.id === "t1")?.enabled === false);
    check("toggled-off pin is not injected", !(await render()).includes("toggle me"));
    check("dialog returns to the list after toggle", afterToggleOptions?.some((o) => o.startsWith("+")));
}

// ---------------------------------------------------------------------------
group("Tool schema compatibility (defer / skipPermission fields)");
{
    const pinTools = tools.filter((t) => t.name.startsWith("pin_"));
    check("all five pin_* tools are registered", pinTools.length === 5);
    // `defer` is a documented SDK tool field ("auto" | "never"); we set "never" so
    // the pin tools stay visible to the model instead of hiding behind tool search.
    check("pin tools declare defer: 'never'", pinTools.every((t) => t.defer === "never"));
    check("no pin tool uses an unsupported defer value",
        pinTools.every((t) => t.defer === undefined || t.defer === "auto" || t.defer === "never"));
    // These are model-initiated helpers guarded by their own consent gates, so they
    // declare skipPermission to avoid a redundant outer permission prompt.
    check("pin tools declare skipPermission: true", pinTools.every((t) => t.skipPermission === true));
}

// ---------------------------------------------------------------------------
group("Diagnostics are user-driven (no test_without_pin / suppress tool)");
{
    check("test_without_pin tool was removed", !tools.some((t) => t.name === "test_without_pin"));
    check("no agent tool can persistently disable or suppress a pin",
        !tools.some((t) => /disable|suppress/i.test(t.name)));
}

// ---------------------------------------------------------------------------
group("Consent gates for pin-removing tools (pin_remove / pin_clear)");
{
    // unpin: approve -> removed; decline -> kept; no UI -> refused + kept.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "u1", type: "prompt", text: "remove me", enabled: true }]);
    let r = await tool.pin_remove.handler({ number: 1 }, inv);
    check("unpin asks for confirmation", state.confirmCalls.length === 1);
    check("unpin (approved) removes the pin", readPins().length === 0);
    check("unpin (approved) uses unified voice", /^Unpinned pin 1: "remove me"\.$/.test(r));

    freshSession();
    state.elicitation = true; state.confirmReturn = false;
    seedPins([{ id: "u1", type: "prompt", text: "remove me", enabled: true }]);
    r = await tool.pin_remove.handler({ number: 1 }, inv);
    check("unpin (declined) keeps the pin", readPins().some((p) => p.id === "u1"));

    freshSession();
    state.elicitation = false;
    seedPins([{ id: "u1", type: "prompt", text: "remove me", enabled: true }]);
    r = await tool.pin_remove.handler({ number: 1 }, inv);
    check("unpin (no UI) refuses", /confirmation/i.test(r));
    check("unpin (no UI) keeps the pin", readPins().some((p) => p.id === "u1"));

    // pin_clear: approve -> wiped; decline -> kept; no UI -> refused + kept.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "c1", type: "prompt", text: "a", enabled: true }, { id: "c2", type: "prompt", text: "b", enabled: true }]);
    const cleared = await tool.pin_clear.handler({}, inv);
    check("pin_clear (approved) wipes all pins", readPins().length === 0);
    check("pin_clear (approved) uses unified voice", /^Cleared 2 pins\.$/.test(cleared));

    freshSession();
    state.elicitation = true; state.confirmReturn = false;
    seedPins([{ id: "c1", type: "prompt", text: "a", enabled: true }, { id: "c2", type: "prompt", text: "b", enabled: true }]);
    await tool.pin_clear.handler({}, inv);
    check("pin_clear (declined) keeps all pins", readPins().length === 2);

    freshSession();
    state.elicitation = false;
    seedPins([{ id: "c1", type: "prompt", text: "a", enabled: true }]);
    const cr = await tool.pin_clear.handler({}, inv);
    check("pin_clear (no UI) refuses", /confirmation/i.test(cr));
    check("pin_clear (no UI) keeps pins", readPins().length === 1);
}

// ---------------------------------------------------------------------------
group("unpin does not leak disabled-pin content (probing oracle)");
{
    // match must NOT find a disabled pin (it would be a content-probing oracle,
    // since pin_list redacts disabled content).
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "d1", type: "prompt", text: "SECRET disabled rule", enabled: false }]);
    let r = await tool.pin_remove.handler({ match: "SECRET" }, inv);
    check("unpin match does not find a disabled pin", /no matching pin/i.test(r));
    check("unpin match did not ask to confirm (nothing matched)", state.confirmCalls.length === 0);
    check("disabled pin still present", readPins().some((p) => p.id === "d1"));

    // match DOES still find an enabled pin.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "e1", type: "prompt", text: "visible enabled rule", enabled: true }]);
    r = await tool.pin_remove.handler({ match: "visible" }, inv);
    check("unpin match finds an enabled pin", readPins().length === 0);

    // Removing a disabled pin by id must NOT echo its content back to the model.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "d2", type: "prompt", text: "SECRET disabled content", enabled: false }]);
    r = await tool.pin_remove.handler({ number: 1 }, inv);
    // A session-rooted FILE pin must match only on its display path (the relative
    // stored name), never on the resolved absolute path. Matching an absolute-path
    // fragment (e.g. the "pinsess" session-dir prefix) would be a path oracle.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([{ id: "f1", type: "file", path: "notes.md", enabled: true }]);
    r = await tool.pin_remove.handler({ match: "pinsess" }, inv);
    check("unpin match does not hit the absolute session-path fragment", /no matching pin/i.test(r));
    check("file pin still present after abs-path-fragment probe", readPins().some((p) => p.id === "f1"));
    r = await tool.pin_remove.handler({ match: "notes" }, inv);
    check("unpin match still finds the file pin by its display name", readPins().length === 0);
}

// ---------------------------------------------------------------------------
group("Pin dialog order + pin_file path normalization");
{
    const runPin = globalThis.__pins.commands.find((c) => c.name === "pin").handler;

    // The individual pin dialog must offer Edit, then Disable/Enable, then Delete.
    freshSession();
    state.elicitation = true;
    seedPins([{ id: "o1", type: "prompt", text: "order me", enabled: true }]);
    let detailOptions = null;
    state.elicitResponders = [
        (_m, opts) => opts.find((o) => !o.startsWith("+")),          // select the pin
        (_m, opts) => { detailOptions = opts.slice(); return null; }, // capture detail order, exit
    ];
    await runPin({ args: "", sessionId: inv.sessionId });
    check("pin dialog order is Edit, Disable, Delete", JSON.stringify(detailOptions) === JSON.stringify(["Edit", "Disable", "Delete"]));

    // A disabled pin's dialog offers Enable (not Disable), still in the middle.
    freshSession();
    state.elicitation = true;
    seedPins([{ id: "o2", type: "prompt", text: "enable me", enabled: false }]);
    detailOptions = null;
    state.elicitResponders = [
        (_m, opts) => opts.find((o) => !o.startsWith("+")),
        (_m, opts) => { detailOptions = opts.slice(); return null; },
    ];
    await runPin({ args: "", sessionId: inv.sessionId });
    check("disabled pin dialog order is Edit, Enable, Delete", JSON.stringify(detailOptions) === JSON.stringify(["Edit", "Enable", "Delete"]));

    // A file pin's dialog offers Open first, to open the file in an editor.
    freshSession();
    state.elicitation = true;
    writeFileSync(join(state.sessionRoot, "files", "doc.md"), "hi");
    seedPins([{ id: "fo", type: "file", path: "doc.md", enabled: true }]);
    detailOptions = null;
    state.elicitResponders = [
        (_m, opts) => opts.find((o) => !o.startsWith("+")),
        (_m, opts) => { detailOptions = opts.slice(); return null; },
    ];
    await runPin({ args: "", sessionId: inv.sessionId });
    check("file pin dialog order is Open, Edit, Disable, Delete", JSON.stringify(detailOptions) === JSON.stringify(["Open", "Edit", "Disable", "Delete"]));

    // Selecting Open hands the file to the agent (session.send) and exits, without
    // changing the pin.
    freshSession();
    state.elicitation = true;
    writeFileSync(join(state.sessionRoot, "files", "doc.md"), "hi");
    seedPins([{ id: "fo2", type: "file", path: "doc.md", enabled: true }]);
    state.elicitResponders = [
        (_m, opts) => opts.find((o) => !o.startsWith("+")),
        (_m, opts) => opts.find((o) => o === "Open"),
    ];
    await runPin({ args: "", sessionId: inv.sessionId });
    check("Open asks the agent to open the file", state.sentMessages.some((m) => /open this file in an editor/i.test(m) && m.includes("doc.md")));
    check("Open leaves the pin unchanged", readPins().length === 1 && readPins()[0].id === "fo2");

    // pin_file must tolerate a leading @ (or @@) on the path argument.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "note.md"), "hi");
    await tool.pin_file.handler({ path: "@note.md" }, inv);
    check("pin_file strips a single leading @", readPins().some((p) => p.type === "file"));

    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "note.md"), "hi");
    await tool.pin_file.handler({ path: "@@note.md" }, inv);
    check("pin_file strips a doubled leading @@", readPins().some((p) => p.type === "file"));

    // A file genuinely inside <session>/files, given via an absolute path whose
    // casing differs from the session dir, must still be stored as a RELATIVE pin
    // (never absolute) — otherwise the session/home path would leak. On win32
    // path.relative is already case-insensitive; on macOS the case-insensitive
    // retry in insideRelative() covers it. On case-sensitive Linux this pins by
    // the exact path, which is correct there.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "Cased.md"), "hi");
    const filesDir = join(state.sessionRoot, "files");
    const mixedAbs = process.platform === "win32"
        ? join(filesDir.toUpperCase(), "Cased.md")   // flip drive/prefix case
        : join(filesDir, "Cased.md");
    await tool.pin_file.handler({ path: mixedAbs }, inv);
    const casedPin = readPins().find((p) => p.type === "file");
    check("pin_file stores a case-variant in-session path as a file pin", !!casedPin);
    check("pin_file does not store an in-session file as an absolute pin", casedPin && !casedPin.path.includes(":") && !casedPin.path.startsWith("/"));

    // A file whose NAME begins with dots (e.g. "..notes.md") is still inside the
    // session files dir — a leading ".." must only count as "outside" when it is a
    // whole path segment, not a filename prefix. Given via its absolute path, it
    // must be stored as a RELATIVE pin (never absolute), or the session path leaks.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "..notes.md"), "hi");
    await tool.pin_file.handler({ path: join(state.sessionRoot, "files", "..notes.md") }, inv);
    const dotPin = readPins().find((p) => p.type === "file");
    check("pin_file pins a dotted-name in-session file", !!dotPin);
    check("pin_file stores a dotted-name file relatively, not absolutely", dotPin && dotPin.path === "..notes.md");

    // De-duping: pinning the same in-session file twice must not create a second
    // pin. On case-insensitive filesystems a case-variant path is the same file, so
    // it must also dedupe (via samePath's resolve + case-fold).
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "files", "Dup.md"), "hi");
    await tool.pin_file.handler({ path: "Dup.md" }, inv);
    const afterFirst = readPins().length;
    const variant = process.platform === "win32" || process.platform === "darwin" ? "dup.md" : "Dup.md";
    const dupOut = await tool.pin_file.handler({ path: variant }, inv);
    check("pinning the same file again does not add a second pin", readPins().length === afterFirst);
    check("duplicate pin_file reports it is already pinned", /already pinned/i.test(dupOut));

    // Bare '@' (no filename) is still rejected cleanly.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    const bare = await tool.pin_file.handler({ path: "@" }, inv);
    check("pin_file rejects a bare @", /no file path/i.test(bare) && readPins().length === 0);

    // A relative path with '..' must be rejected (it would escape <session>/files
    // and be stored as an absolute pin, bypassing the load-time traversal guard).
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    writeFileSync(join(state.sessionRoot, "secret.txt"), "TOPSECRET");   // sits OUTSIDE files/
    const trav = await tool.pin_file.handler({ path: "@../secret.txt" }, inv);
    check("pin_file rejects a relative traversal path", /can't contain '\.\.'/i.test(trav));
    check("pin_file traversal attempt pins nothing", readPins().length === 0);
    check("pin_file traversal did not even ask to confirm", state.confirmCalls.length === 0);

    // A path that exists but ISN'T a regular file (a directory) is a genuine error
    // and must be refused — this is the surviving hard-fail path now that a merely
    // missing file is pinned optimistically. The message must not leak the absolute
    // session/home path and must not pin anything.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    mkdirSync(join(state.sessionRoot, "files", "adir"));
    const dirOut = await tool.pin_file.handler({ path: "adir" }, inv);
    check("pin_file (directory) is refused", /isn't a file/i.test(dirOut) && readPins().length === 0);
    check("pin_file (directory) does not leak the absolute path", !dirOut.includes(state.sessionRoot));
    check("pin_file (directory) uses the relative display path", dirOut.includes("adir"));

    // /pin remove <n> reports the pin number in the deletion message.
    freshSession();
    state.elicitation = true; state.confirmReturn = true;
    seedPins([
        { id: "a", type: "prompt", text: "first", enabled: true },
        { id: "b", type: "prompt", text: "second", enabled: true },
    ]);
    await runPin({ args: "remove 2", sessionId: inv.sessionId });
    check("delete message names the pin number", state.logs.some((m) => /Unpinned pin 2:/.test(m)));
    check("the right pin was removed", readPins().length === 1 && readPins()[0].id === "a");
}

// ---------------------------------------------------------------------------
group("COPILOT_HOME fallback (no workspacePath)");
{
    function findFile(dir, name) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                const hit = findFile(full, name);
                if (hit) return hit;
            } else if (entry.name === name) {
                return full;
            }
        }
        return null;
    }

    const home = mkdtempSync(join(tmpdir(), "copilothome-"));
    const savedEnv = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    freshSession();
    state.noWorkspace = true;          // force the fallback path
    state.elicitation = true; state.confirmReturn = true;
    let threw = false;
    try { await tool.pin_prompt.handler({ text: "home fallback" }, inv); } catch { threw = true; }
    check("pin write under COPILOT_HOME did not throw", !threw);
    const found = findFile(home, "pins.json");
    check("pins.json is written under $COPILOT_HOME/session-state", found !== null && found.includes(join("session-state")));

    // restore
    state.noWorkspace = false;
    if (savedEnv === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = savedEnv;
    try { rmSync(home, { recursive: true, force: true }); } catch {}
}

group("COPILOT_HOME with a leading ~ is expanded");
{
    // A COPILOT_HOME like "~/<name>" must resolve under the real home directory,
    // not a literal "./~/..." relative dir. Use a unique subfolder of home so the
    // test is isolated and cleanable.
    const unique = `sp-tilde-test-${process.pid}-${Date.now()}`;
    const expandedRoot = join(homedir(), unique);
    const savedEnv = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = `~/${unique}`;
    freshSession();
    state.noWorkspace = true;          // force the COPILOT_HOME fallback path
    state.elicitation = true; state.confirmReturn = true;
    let threw = false;
    try { await tool.pin_prompt.handler({ text: "tilde home" }, inv); } catch { threw = true; }
    check("pin write under ~-form COPILOT_HOME did not throw", !threw);
    const litter = join(process.cwd(), "~");
    check("no literal ~ directory created in cwd", !existsSync(litter));
    check("pins.json is written under the expanded home path", existsSync(expandedRoot));

    // restore
    state.noWorkspace = false;
    if (savedEnv === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = savedEnv;
    try { rmSync(expandedRoot, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
group("Path-traversal rejection in file pins");
{
    freshSession();
    // A secret sitting just outside the session files folder.
    writeFileSync(join(state.sessionRoot, "secret.txt"), "TOPSECRET");
    writeFileSync(join(state.sessionRoot, "files", "ok.md"), "fine");
    seedPins([
        { id: "trav", type: "file", path: "../secret.txt", enabled: true },  // must be dropped
        { id: "deep", type: "file", path: "a/../../secret.txt", enabled: true }, // must be dropped
        { id: "ok", type: "file", path: "ok.md", enabled: true },            // must survive
    ]);
    const out = await render();
    check("traversal pin content is never injected", !out.includes("TOPSECRET"));
    check("legit relative pin still injected", out.includes("fine"));
    const listed = await tool.pin_list.handler({}, inv);
    check("only the safe pin survives load", (listed.match(/^\d+\. /gm) || []).length === 1 && listed.includes("@ok.md"));
    check("dropped-pins warning logged for traversal", state.logs.some((m) => /dropped 2 malformed/.test(m)));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (state.sessionRoot) {
    try { rmSync(state.sessionRoot, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
