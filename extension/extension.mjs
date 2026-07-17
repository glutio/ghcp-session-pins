// Copilot CLI extension: session-pins
// A single `/pin` command (MCP-style subcommands) that manages editable prompt
// pins and live file pins for the current Copilot session. Pinned context is
// injected into every prompt.
//
// Usage:
//   /pin                  Open the interactive pinboard (browse / add / edit / enable-disable / delete).
//   /pin add <text>       Pin an editable instruction.
//   /pin add @<path>      Pin a live file (reread from disk every prompt).
//   /pin list             List pins with their numbers.
//   /pin edit [n]         Edit a pin in place.
//   /pin remove [n]       Delete a pin.
//   /pin clear            Delete all pins.
//
// Pins live inside the session folder (session.workspacePath), so they travel
// with the session and are cleaned up when the session is deleted.

import { joinSession } from "@github/copilot-sdk/extension";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const stores = new Map();
// One-shot, in-memory diagnostic suppressions: sessionId -> Set<pinId>. The agent
// can ask (via test_without_pin) to omit a pin for just the NEXT turn to test
// whether it's causing a problem. This is deliberately never written to pins.json
// and is consumed (cleared) by the next render, so it can't get "stuck off" — even
// if the agent is interrupted, the pin is active again on the following turn. Only
// the user can persistently enable/disable a pin (via the pinboard).
const suppressedOnce = new Map();
// Per-path in-flight load promise. Without this, two callers hitting a fresh
// session at the same time can both pass the `stores.has` check and each parse
// pins.json into a separate store object; a later save on one instance would then
// silently drop pins added on the other. Coalescing concurrent first loads onto a
// single promise guarantees every caller shares the same store object.
const storeLoads = new Map();
// Per-path write queue so concurrent saveStore calls to the same pins.json are
// serialized — otherwise their rename() calls can land out of order and an older
// snapshot could overwrite a newer one (last-writer-wins data loss).
const saveQueues = new Map();

// Max characters shown when previewing a prompt pin's text (in the pinboard, the
// list_pins tool, and log lines). Kept in one place so every preview truncates
// at the same, generous length.
const PREVIEW_LENGTH = 240;

// Max bytes of a pinned file injected into a prompt. Larger files are truncated
// with a notice so an accidentally-pinned huge file can't blow up the context.
const MAX_PINNED_FILE_BYTES = 64 * 1024;

// Subdirectory of the session folder (session.workspacePath) where Copilot keeps
// session-level user files. The SDK has no getter for it — it's the documented
// `files/` convention — so it's defined once here and used only by
// sessionFilesDir(); change this single line if the convention ever changes.
const SESSION_FILES_SUBDIR = "files";

function safeId(sessionId) {
    return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Pin object factories — the single source of truth for a pin's shape, so every
// call site (command, buildPin, and the tools) produces identical objects.
// A prompt pin carries editable text. A file pin's `path` is stored *relative to
// the session files folder* when the file lives inside it (the session is the
// root), or absolute when the file is outside the session — resolveFilePin()
// turns either form back into an absolute path at read time.
function makePromptPin(text) {
    return { id: randomUUID(), type: "prompt", text, enabled: true };
}

function makeFilePin(storedPath) {
    return { id: randomUUID(), type: "file", path: storedPath, enabled: true };
}

// A pin is active (injected every turn) unless it has been explicitly disabled by
// the user. Absent `enabled` means enabled, so pins written by older versions stay
// active. Disabled pins are kept and shown in the pinboard but never injected.
function isEnabled(pin) {
    return pin.enabled !== false;
}

// A pin loaded from disk is only usable if it has the exact shape the rest of the
// code assumes: a string id, a known type, and the type's string payload. A
// hand-edited or partially-corrupt pins.json could otherwise carry an entry that
// makes e.g. resolveFilePin() -> isAbsolute(pin.path) throw. Invalid entries are
// dropped on load so a bad record can't crash a /pin command or the prompt hook.
function isValidPin(pin) {
    if (!pin || typeof pin !== "object" || typeof pin.id !== "string") {
        return false;
    }
    if (pin.type === "prompt") {
        return typeof pin.text === "string";
    }
    if (pin.type === "file") {
        if (typeof pin.path !== "string" || pin.path.length === 0) {
            return false;
        }
        // A relative file-pin path is resolved under the session files folder, so a
        // hand-edited pins.json entry like "../.ssh/id_rsa" would traverse outside
        // it and read arbitrary files into prompt context. Reject relative paths
        // that contain a ".." segment. (Absolute pins are an intentional feature for
        // files outside the session and are left as-is.)
        if (!isAbsolute(pin.path) && pin.path.split(/[\\/]/).includes("..")) {
            return false;
        }
        return true;
    }
    return false;
}

// Resolve the pins file for a session. Prefer the live session workspace folder;
// fall back to the documented session-state layout when it is unavailable.
function pinsFile(sessionId) {
    return join(sessionDir(sessionId), "pins.json");
}

// The session's own folder (<copilot-home>/session-state/<id>), which holds
// pins.json alongside plan.md / checkpoints / files. Prefer the live workspace
// path; otherwise honor COPILOT_HOME (Copilot CLI's configurable home) before
// falling back to the default ~/.copilot, so pins land in the right place when the
// home is relocated.
function copilotHome() {
    const configured = process.env.COPILOT_HOME?.trim();
    return configured ? configured : join(homedir(), ".copilot");
}

function sessionDir(sessionId) {
    return session?.workspacePath ?? join(copilotHome(), "session-state", safeId(sessionId));
}

// The root for session-level user files (<session>/files). Session file pins are
// stored relative to this, and typed relative paths resolve against it.
function sessionFilesDir(sessionId) {
    return join(sessionDir(sessionId), SESSION_FILES_SUBDIR);
}

// True when an absolute path is inside a base directory.
function isInsideDir(baseDir, absolutePath) {
    if (!baseDir) {
        return false;
    }
    const rel = relative(baseDir, absolutePath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// How a resolved absolute path is stored: relative to the session files folder
// when it lives inside it (session-rooted), otherwise the absolute path.
function toStoredPath(absolutePath, sessionId) {
    const base = sessionFilesDir(sessionId);
    if (isInsideDir(base, absolutePath)) {
        const rel = relative(base, absolutePath);
        return rel === "" ? basename(absolutePath) : rel;
    }
    return absolutePath;
}

// Turn a stored file-pin path back into an absolute path for reads. A relative
// pin is rooted at the session files folder (stable for the session's life); an
// absolute pin is used as-is.
function resolveFilePin(pin, sessionId) {
    return isAbsolute(pin.path) ? pin.path : join(sessionFilesDir(sessionId), pin.path);
}

// Resolve a user/model-supplied path to absolute using the session-rooted rule:
// a relative path is rooted at the session files folder; an absolute path is
// used as-is.
function resolveInputPath(rawPath, sessionId) {
    return isAbsolute(rawPath) ? rawPath : resolve(sessionFilesDir(sessionId), rawPath);
}

async function loadStore(sessionId) {
    const path = pinsFile(sessionId);
    if (stores.has(path)) {
        return stores.get(path);
    }
    // Coalesce concurrent first loads for this path onto one promise so every
    // caller awaits (and shares) the same store object.
    const inFlight = storeLoads.get(path);
    if (inFlight) {
        return inFlight;
    }

    const load = (async () => {
        let store = { version: 1, pins: [] };
        try {
            const parsed = JSON.parse(await readFile(path, "utf8"));
            if (parsed?.version === 1 && Array.isArray(parsed.pins)) {
                const valid = parsed.pins.filter(isValidPin);
                store = { version: 1, pins: valid };
                const dropped = parsed.pins.length - valid.length;
                if (dropped > 0) {
                    await session.log(
                        `session-pins: dropped ${dropped} malformed pin${dropped === 1 ? "" : "s"} from pins.json.`,
                        { level: "warning", ephemeral: true },
                    );
                }
            }
        } catch (error) {
            // Missing file is normal (fresh session). Any other error — including a
            // corrupt/unparseable pins.json — is treated as an empty pinboard so it
            // can never crash a command or the prompt hook. The next save overwrites
            // the bad file atomically.
            if (error?.code !== "ENOENT") {
                await session.log(
                    `session-pins: ignoring unreadable pin store (${error.message}); starting empty.`,
                    { level: "warning", ephemeral: true },
                );
            }
        }
        // Only publish to the shared cache if another caller hasn't already (a
        // concurrent save could have set a fresher store while we were reading).
        if (!stores.has(path)) {
            stores.set(path, store);
        }
        return stores.get(path);
    })();

    storeLoads.set(path, load);
    try {
        return await load;
    } finally {
        storeLoads.delete(path);
    }
}

async function saveStore(sessionId, store) {
    const path = pinsFile(sessionId);
    const write = async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        const body = `${JSON.stringify(store, null, 2)}\n`;
        // Durable atomic write: fsync the temp file before renaming it over the
        // target (rename is atomic on Win32 via MoveFileEx-replace and on POSIX).
        // Without the fsync, a crash/power loss right after the rename could leave
        // a zero-length or partial pins.json, which loadStore would then treat as
        // corrupt and silently reset to empty — losing every pin.
        let handle;
        try {
            handle = await open(temporaryPath, "w");
            await handle.writeFile(body, "utf8");
            await handle.sync();
        } finally {
            if (handle) {
                await handle.close();
            }
        }
        await rename(temporaryPath, path);
        stores.set(path, store);
    };
    // Chain onto any in-flight save for this path so writes (and their renames)
    // happen strictly in order. Run regardless of whether the previous save
    // succeeded, and keep a failure-swallowing tail so one bad save can't wedge
    // the queue — while each caller still awaits (and sees) its own result.
    const previous = saveQueues.get(path) ?? Promise.resolve();
    const result = previous.then(write, write);
    saveQueues.set(
        path,
        result.catch(() => {}),
    );
    return result;
}

function shortText(text, maxLength = PREVIEW_LENGTH) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length <= maxLength
        ? oneLine
        : `${oneLine.slice(0, maxLength - 1)}…`;
}

// Escape XML metacharacters so pinned text/file contents can't break out of the
// <prompt-pin> / <live-file-pin> wrapper boundaries (defense against a pinned
// file that contains a literal closing tag being used for prompt-injection).
function escapeXml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Escape a value for use inside a double-quoted XML attribute. Beyond the element
// escapes, attribute values must also escape quotes so a path/value containing `"`
// (or `'`) can't terminate the attribute and inject extra markup. Coerces to a
// string first so a non-string never throws here.
function escapeXmlAttr(value) {
    return escapeXml(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function pinLabel(pin, index, sessionId) {
    const number = `${index + 1}.`;
    // Filled circle for an active pin, hollow circle for a disabled one. (Not a ✓
    // — the host's single-select widget uses ✓ as its own selection marker, so
    // reusing it here would be ambiguous.) Plain monochrome glyphs; the interactive
    // picker renders option labels as text and doesn't reliably honor ANSI color.
    const mark = isEnabled(pin) ? "\u25cf" : "\u25cb";
    if (pin.type === "prompt") {
        return `${mark} ${number} "${shortText(pin.text)}"`;
    }
    // Show the path as stored: relative to the session files folder for files that
    // live there, absolute for files anywhere else. Normalized via the resolved
    // absolute path so even legacy/absolute-stored session files display relative.
    const display = toStoredPath(resolveFilePin(pin, sessionId), sessionId);
    return `${mark} ${number} @${display}`;
}

function cleanPathArgument(raw) {
    let value = raw.trim();
    if (value.startsWith("@")) {
        value = value.slice(1).trim();
    }
    const first = value[0];
    const last = value[value.length - 1];
    if (
        value.length >= 2 &&
        ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ) {
        value = value.slice(1, -1);
    }
    value = value.trim();

    // Expand a leading ~ (e.g. from the @ file picker) to the home directory,
    // since path.resolve does not treat ~ specially.
    if (value === "~") {
        value = homedir();
    } else if (value.startsWith("~/") || value.startsWith("~\\")) {
        value = join(homedir(), value.slice(2));
    }

    return value;
}

// Turn raw user text into a pin object.
// Text starting with "@" becomes a live file pin; everything else is a prompt pin.
// Returns { ok, pin } on success or { ok: false, error } on failure.
async function buildPin(raw, sessionId) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
        return { ok: false };
    }

    if (trimmed.startsWith("@")) {
        const rawPath = cleanPathArgument(trimmed);
        if (!rawPath) {
            return { ok: false, error: "No file path was provided." };
        }

        // Session-rooted: a relative path resolves against the session files
        // folder; an absolute path is used as-is.
        const absolutePath = resolveInputPath(rawPath, sessionId);
        let info;
        try {
            info = await stat(absolutePath);
        } catch (error) {
            return { ok: false, error: `Cannot pin ${fmtPath(absolutePath)}: ${error.message}` };
        }
        if (!info.isFile()) {
            return { ok: false, error: `Cannot pin ${fmtPath(absolutePath)}: it is not a file.` };
        }

        return {
            ok: true,
            pin: makeFilePin(toStoredPath(absolutePath, sessionId)),
        };
    }

    return { ok: true, pin: makePromptPin(trimmed) };
}

// Quick-add path: `/pin <text>` or `/pin @<path>`.
async function addFromArgs(ctx, raw) {
    const result = await buildPin(raw, ctx.sessionId);
    if (!result.ok) {
        if (result.error) {
            await session.log(result.error, { level: "error" });
        }
        return;
    }

    const status = await addPinToStore(ctx.sessionId, result.pin);
    await session.log(status.message, { level: "info" });
}

// Add a pin object to a session's store (deduping live files by their resolved
// absolute path). Returns a short status. Shared by the /pin command and tools.
async function addPinToStore(sessionId, pin) {
    const store = await loadStore(sessionId);
    if (pin.type === "file") {
        const target = resolveFilePin(pin, sessionId);
        const dup = store.pins.some(
            (p) => p.type === "file" && resolveFilePin(p, sessionId) === target,
        );
        if (dup) {
            return { added: false, message: `Already pinned live: ${fileLabel(pin, sessionId)}` };
        }
    }
    store.pins.push(pin);
    await saveStore(sessionId, store);
    return {
        added: true,
        message:
            pin.type === "file"
                ? `Pinned live file: ${fileLabel(pin, sessionId)}`
                : `Pinned prompt: ${shortText(pin.text)}`,
    };
}

// Wrap a path (or any literal) in a Markdown inline code span so rendering doesn't
// eat backslashes in Windows paths (e.g. `\.` -> `.`). Backticks are legal in file
// names on macOS/Linux (and Windows), so size the fence one longer than the value's
// longest backtick run, and pad with a space when it starts/ends with a backtick
// (CommonMark strips a single surrounding space), so the span never breaks.
function fmtPath(p) {
    const value = String(p);
    const longestRun = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = "`".repeat(longestRun + 1);
    const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${pad}${value}${pad}${fence}`;
}

// A file pin's label for status messages and tool results: the stored/display
// path (relative for session-rooted pins, absolute for files outside the
// session), matching the pinboard and avoiding leaking the home dir/username into
// model-visible output for session-rooted pins.
function fileLabel(pin, sessionId) {
    return fmtPath(toStoredPath(resolveFilePin(pin, sessionId), sessionId));
}

function elicitationEnabled() {
    return Boolean(session.capabilities.ui?.elicitation);
}

// Strict single-choice picker built on a `oneOf` schema. The host still appends
// its own non-removable "Other (type your answer)" freeform row (see the guard in
// the body), but the `oneOf` constrains our listed options to exact values so we
// can reliably detect and reject anything the user types into that "Other" row.
// Returns the chosen option, or null if cancelled/declined.
async function choose(message, options) {
    const result = await session.ui.elicitation({
        message,
        requestedSchema: {
            type: "object",
            properties: {
                selection: {
                    type: "string",
                    title: "Choose",
                    oneOf: options.map((option) => ({ const: option, title: option })),
                },
            },
            required: ["selection"],
        },
    });
    if (result.action === "accept" && result.content?.selection != null) {
        // The host always appends an "Other (type your answer)" freeform row to
        // single-choice dialogs; it can't be removed. If the user lands on it and
        // types something that isn't one of our options, treat it as a cancel so
        // it can never create a bogus pin or mis-target an action.
        return options.includes(result.content.selection) ? result.content.selection : null;
    }
    return null;
}

// Ask for a new pin through a dialog, then add it.
async function addViaDialog(ctx) {
    if (!elicitationEnabled()) {
        await session.log(
            "This host has no interactive prompt. Add a pin inline instead, e.g. `/pin add <instruction>` or `/pin add @<path>`.",
            { level: "info" },
        );
        return;
    }
    const raw = await session.ui.input(
        "New pin — type an instruction, or @path to pin a live file:",
        { title: "Add a pin", minLength: 1 },
    );
    if (raw === null) {
        return;
    }
    await addFromArgs(ctx, raw);
}

// Edit a pin in place (text for prompt pins, path for file pins).
async function editPin(ctx, store, index) {
    const pin = store.pins[index];
    if (!pin) {
        return;
    }

    if (pin.type === "prompt") {
        const edited = await session.ui.input("Edit the pinned instruction:", {
            title: "Edit prompt pin",
            minLength: 1,
            default: pin.text,
        });
        const text = edited?.trim();
        if (!text || text === pin.text) {
            return;
        }
        pin.text = text;
        await saveStore(ctx.sessionId, store);
        await session.log(`Updated prompt pin: ${shortText(text)}`, { level: "info" });
        return;
    }

    const editedPath = await session.ui.input("Edit the file path (@ optional):", {
        title: "Edit live file pin",
        minLength: 1,
        default: pin.path,
    });
    if (editedPath === null) {
        return;
    }

    const cleaned = cleanPathArgument(editedPath);
    if (!cleaned) {
        return;
    }

    const absolutePath = resolveInputPath(cleaned, ctx.sessionId);
    if (absolutePath === resolveFilePin(pin, ctx.sessionId)) {
        return;
    }

    const duplicate = store.pins.some(
        (p) => p !== pin && p.type === "file" && resolveFilePin(p, ctx.sessionId) === absolutePath,
    );
    if (duplicate) {
        await session.log(`That file is already pinned: ${fmtPath(absolutePath)}`, { level: "info" });
        return;
    }

    let info;
    try {
        info = await stat(absolutePath);
    } catch (error) {
        await session.log(`Cannot pin ${fmtPath(absolutePath)}: ${error.message}`, { level: "error" });
        return;
    }
    if (!info.isFile()) {
        await session.log(`Cannot pin ${fmtPath(absolutePath)}: it is not a file.`, { level: "error" });
        return;
    }

    pin.path = toStoredPath(absolutePath, ctx.sessionId);
    await saveStore(ctx.sessionId, store);
    await session.log(`Updated live file pin: ${fmtPath(absolutePath)}`, { level: "info" });
}

async function deletePin(ctx, store, index) {
    const pin = store.pins[index];
    if (!pin) {
        return false;
    }
    if (elicitationEnabled()) {
        const confirmed = await session.ui.confirm(`Delete ${pinLabel(pin, index, ctx.sessionId)}?`);
        if (!confirmed) {
            return false;
        }
    }
    store.pins.splice(index, 1);
    await saveStore(ctx.sessionId, store);
    await session.log(`Pin ${index + 1} deleted.`, { level: "info" });
    return true;
}

// Interactive pinboard: browse, add, edit, and delete. Loops until the user is done.
async function openPinboard(ctx) {
    if (!elicitationEnabled()) {
        await listPins(ctx);
        return;
    }

    const ADD = "+ Add a pin";

    while (true) {
        const store = await loadStore(ctx.sessionId);
        const pinItems = store.pins.map((pin, index) => pinLabel(pin, index, ctx.sessionId));
        const choice = await choose(
            store.pins.length ? "Session pins" : "No pins yet",
            [...pinItems, ADD],
        );

        if (choice === null) {
            return;
        }

        if (choice === ADD) {
            await addViaDialog(ctx);
            continue;
        }

        const index = pinItems.indexOf(choice);
        if (index === -1) {
            continue;
        }

        // Individual pin dialog — its own loop, so editing (or a cancelled delete)
        // returns here rather than jumping back out to the list. Only Back/Esc here
        // returns to the list.
        while (true) {
            const selected = store.pins[index];
            if (!selected) {
                break;
            }
            const detail =
                selected.type === "prompt"
                    ? selected.text
                    : `@${toStoredPath(resolveFilePin(selected, ctx.sessionId), ctx.sessionId)}`;
            const toggleLabel = isEnabled(selected) ? "Disable" : "Enable";
            const action = await choose(detail, ["Edit", toggleLabel, "Delete"]);

            if (action === null) {
                break;
            }
            if (action === toggleLabel) {
                selected.enabled = !isEnabled(selected);
                await saveStore(ctx.sessionId, store);
                await session.log(
                    `${isEnabled(selected) ? "Enabled" : "Disabled"} pin ${index + 1}.`,
                    { level: "info" },
                );
                // Return to the list so the change is immediately visible (the
                // pin's ●/○ marker updates).
                break;
            }
            if (action.includes("Edit")) {
                await editPin(ctx, store, index);
                continue;
            }
            if (action.includes("Delete")) {
                if (await deletePin(ctx, store, index)) {
                    break;
                }
            }
        }
    }
}

async function listPins(ctx) {
    const store = await loadStore(ctx.sessionId);
    if (store.pins.length === 0) {
        await session.log("No session pins. Add one with /pin add <text> or /pin add @<path>.", {
            level: "info",
        });
        return;
    }
    const lines = store.pins.map((pin, index) => `  ${pinLabel(pin, index, ctx.sessionId)}`);
    await session.log(`Session pins:\n${lines.join("\n")}`, { level: "info" });
}

// Parse a 1-based pin index from text. Returns a 0-based index, or -1 if invalid.
function parseIndex(text, count) {
    const n = Number.parseInt((text ?? "").trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > count) {
        return -1;
    }
    return n - 1;
}

// Let the user pick a pin from a list. Returns a 0-based index, or -1 if cancelled
// (Esc). No explicit Cancel row — Esc handles it.
async function pickPin(store, prompt, sessionId) {
    const items = store.pins.map((pin, index) => pinLabel(pin, index, sessionId));
    const choice = await choose(prompt, items);
    if (choice === null) {
        return -1;
    }
    return items.indexOf(choice);
}

async function editCommand(ctx, rest) {
    const store = await loadStore(ctx.sessionId);
    if (store.pins.length === 0) {
        await session.log("No pins to edit.", { level: "info" });
        return;
    }
    // Editing always needs an interactive prompt (there is no inline edit syntax),
    // so bail out cleanly rather than letting editPin's session.ui.input throw on a
    // host without elicitation.
    if (!elicitationEnabled()) {
        await session.log(
            "Editing a pin needs an interactive prompt, which isn't available here. Remove it with `/pin remove <n>` and re-add it inline.",
            { level: "info" },
        );
        return;
    }

    let index = rest ? parseIndex(rest, store.pins.length) : -1;
    if (rest && index === -1) {
        await session.log(`No pin #${rest}. Use /pin list to see the numbers.`, { level: "error" });
        return;
    }
    if (index === -1) {
        index = await pickPin(store, "Edit which pin?", ctx.sessionId);
        if (index === -1) {
            return;
        }
    }
    await editPin(ctx, store, index);
}

async function removeCommand(ctx, rest) {
    const store = await loadStore(ctx.sessionId);
    if (store.pins.length === 0) {
        await session.log("No pins to remove.", { level: "info" });
        return;
    }

    let index = rest ? parseIndex(rest, store.pins.length) : -1;
    if (rest && index === -1) {
        await session.log(`No pin #${rest}. Use /pin list to see the numbers.`, { level: "error" });
        return;
    }
    if (index === -1) {
        if (!elicitationEnabled()) {
            await session.log("Specify a pin number, e.g. /pin remove 2.", { level: "info" });
            return;
        }
        index = await pickPin(store, "Remove which pin?", ctx.sessionId);
        if (index === -1) {
            return;
        }
    }
    await deletePin(ctx, store, index);
}

async function clearPins(ctx) {
    const store = await loadStore(ctx.sessionId);
    if (store.pins.length === 0) {
        await session.log("No pins to clear.", { level: "info" });
        return;
    }
    if (elicitationEnabled()) {
        const confirmed = await session.ui.confirm(`Delete all ${store.pins.length} session pins?`);
        if (!confirmed) {
            return;
        }
    }
    const count = store.pins.length;
    store.pins = [];
    await saveStore(ctx.sessionId, store);
    await session.log(`Cleared ${count} session pin${count === 1 ? "" : "s"}.`, { level: "info" });
}

async function showHelp() {
    await session.log(
        [
            "Session pins — pin instructions and live files into every prompt.",
            "  /pin                 Open the interactive pinboard",
            "  /pin add <text>      Pin an editable instruction",
            "  /pin add @<path>     Pin a live file (reread every prompt)",
            "  /pin list            List pins with their numbers",
            "  /pin edit [n]        Edit a pin in place",
            "  /pin remove [n]      Delete a pin",
            "  /pin clear           Delete all pins",
        ].join("\n"),
        { level: "info" },
    );
}

async function handlePin(ctx) {
    const raw = (ctx.args ?? "").trim();
    if (!raw) {
        await openPinboard(ctx);
        return;
    }

    const spaceIndex = raw.search(/\s/);
    const sub = (spaceIndex === -1 ? raw : raw.slice(0, spaceIndex)).toLowerCase();
    const rest = spaceIndex === -1 ? "" : raw.slice(spaceIndex + 1).trim();
    const isEmpty = rest === "";
    const isIndex = /^\d+$/.test(rest);

    // `add` always pins the rest — the explicit way to pin text that begins with a
    // reserved word, e.g. `/pin add clear the cache`.
    if (sub === "add") {
        if (rest) {
            await addFromArgs(ctx, rest);
        } else {
            await addViaDialog(ctx);
        }
        return;
    }

    // Smart-guard: action words only fire when their arguments fit their shape.
    // Otherwise the whole input is pinned as text, so `/pin clear the air with the
    // team` pins that text instead of clearing every pin.
    if ((sub === "list" || sub === "ls") && isEmpty) {
        await listPins(ctx);
        return;
    }
    if (sub === "clear" && isEmpty) {
        await clearPins(ctx);
        return;
    }
    if (sub === "help" && isEmpty) {
        await showHelp();
        return;
    }
    if (sub === "edit" && (isEmpty || isIndex)) {
        await editCommand(ctx, rest);
        return;
    }
    if (
        (sub === "remove" || sub === "rm" || sub === "delete" || sub === "del") &&
        (isEmpty || isIndex)
    ) {
        await removeCommand(ctx, rest);
        return;
    }

    // Everything else is a quick-add: `/pin fix the bug`, `/pin @notes.md`.
    await addFromArgs(ctx, raw);
}

// Record a one-shot diagnostic suppression for the next turn (see suppressedOnce).
function suppressOnce(sessionId, pinId) {
    let set = suppressedOnce.get(sessionId);
    if (!set) {
        set = new Set();
        suppressedOnce.set(sessionId, set);
    }
    set.add(pinId);
}

// Consume (and clear) the one-shot suppressions for a session, so they apply to a
// single render only and then auto-restore.
function takeSuppressed(sessionId) {
    const set = suppressedOnce.get(sessionId);
    if (!set) {
        return new Set();
    }
    suppressedOnce.delete(sessionId);
    return set;
}

async function renderPinnedContext(sessionId) {
    const store = await loadStore(sessionId);
    // Consume any one-shot diagnostic suppressions for this turn, then inject only
    // pins that are enabled and not suppressed. Disabled pins stay saved but silent.
    const suppressed = takeSuppressed(sessionId);
    const activePins = store.pins.filter((pin) => isEnabled(pin) && !suppressed.has(pin.id));
    if (activePins.length === 0) {
        return undefined;
    }

    const sections = [];
    for (const pin of activePins) {
        if (pin.type === "prompt") {
            sections.push(`<prompt-pin id="${escapeXmlAttr(pin.id)}">\n${escapeXml(pin.text)}\n</prompt-pin>`);
            continue;
        }

        const absolutePath = resolveFilePin(pin, sessionId);
        // Read from the resolved absolute path, but expose only the stored/display
        // path in the wrapper attribute: relative for session-rooted pins, absolute
        // for files outside the session. This avoids leaking the user's home
        // directory / username into every model prompt for session-rooted files.
        const displayPath = toStoredPath(absolutePath, sessionId);
        try {
            // Read at most MAX_PINNED_FILE_BYTES + 1 bytes so a huge pinned file
            // never loads fully into memory, and truncate on a real byte boundary
            // (slicing a JS string would count UTF-16 units, not UTF-8 bytes).
            const handle = await open(absolutePath, "r");
            let buffer;
            let overCap;
            try {
                const cap = MAX_PINNED_FILE_BYTES;
                buffer = Buffer.alloc(cap + 1);
                const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0);
                overCap = bytesRead > cap;
                buffer = buffer.subarray(0, Math.min(bytesRead, cap));
            } finally {
                await handle.close();
            }
            let contents = buffer.toString("utf8");
            let truncatedAttr = "";
            if (overCap) {
                contents = `${contents}\n…[truncated: file exceeds ${MAX_PINNED_FILE_BYTES} bytes]`;
                truncatedAttr = " truncated=\"true\"";
            }
            // Escape so file contents (or pinned text) containing `<`, `&`, or a
            // literal closing tag can't break out of the wrapper boundaries.
            sections.push(
                `<live-file-pin id="${escapeXmlAttr(pin.id)}" path="${escapeXmlAttr(displayPath)}"${truncatedAttr}>\n${escapeXml(contents)}\n</live-file-pin>`,
            );
        } catch (error) {
            // Report only the error code (e.g. ENOENT/EACCES), never error.message —
            // Node fs messages embed the absolute path, which would leak the home
            // dir/username into the prompt for session-rooted pins (the path
            // attribute already avoids this).
            const reason = error?.code ? `error code ${error.code}` : "an unknown error";
            sections.push(
                `<live-file-pin id="${escapeXmlAttr(pin.id)}" path="${escapeXmlAttr(displayPath)}" unreadable="true">\n` +
                    `The pinned file could not be read (${escapeXml(reason)}).\n` +
                    `</live-file-pin>`,
            );
        }
    }

    return [
        "<session-pins>",
        "The user deliberately pinned the following instructions and live file contents.",
        "Keep them salient and apply them on this turn. A live file is reread from disk for every prompt.",
        "If you hit unexpected behavior, a conflict, or a task that keeps failing or looping, consider" +
            " whether one of these pins is the cause — a stale, over-broad, or contradictory instruction," +
            " or a pinned file that no longer reflects reality. When it is, tell the user which pin (by its" +
            " id) is interfering. To test a hypothesis, call the test_without_pin tool with that id: it omits" +
            " the pin from just your next turn (auto-restoring afterward, without changing its saved state)," +
            " so you can re-run the failing step and compare. Offer to edit or remove a genuinely bad pin" +
            " (via the /pin command, or the list_pins / unpin tools). Do not silently ignore a pin — surface" +
            " the conflict instead.",
        ...sections,
        "</session-pins>",
    ].join("\n\n");
}

// Consent gate for model-initiated actions that add, remove, or suppress pins.
// These tools are called by the model, so prompt-injection (from a file/web
// result) could try to change the user's pins without them asking. Require an
// explicit confirmation, and refuse when no UI is available. Returns
// { ok: true } to proceed, or { ok: false, message } to return to the model.
async function confirmModelAction(promptMessage, refuseMessage, declinedMessage = "The user declined.") {
    if (!elicitationEnabled()) {
        return { ok: false, message: refuseMessage };
    }
    const approved = await session.ui.confirm(promptMessage);
    return approved ? { ok: true } : { ok: false, message: declinedMessage };
}

// Agent-callable tools. These let Copilot manage pins programmatically: add
// (pin_file / pin_prompt), inspect (list_pins), and remove (unpin / clear_pins).
const tools = [
    {
        name: "pin_file",
        skipPermission: true,
        defer: "never",
        description:
            "Pin a file into the current Copilot session so its live contents are re-read from disk and injected into every subsequent prompt. A relative path is resolved against the session's files folder; pass an absolute path for a file anywhere else (e.g. a file in the user's repo). Use after creating or identifying a file the user wants kept in context.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the file to pin. Relative paths resolve against the session's files folder; use an absolute path for files outside it.",
                },
            },
        },
        handler: async (args, invocation) => {
            // The model may pass the path with or without a leading @ (the @ is
            // user-facing pin syntax, not part of the filename). Strip any leading
            // @ so buildPin receives exactly one and doesn't stat a bogus "@foo".
            const path = String(
                args?.path ?? args?.file ?? args?.filepath ?? args?.filename ?? "",
            )
                .trim()
                .replace(/^@+/, "")
                .trim();
            if (!path) {
                return "No file path was provided. Pass the file path in the 'path' argument.";
            }
            const result = await buildPin(`@${path}`, invocation.sessionId);
            if (!result.ok) {
                return result.error ?? "Could not pin the file.";
            }
            // Security gate: this tool is model-initiated, so a prompt-injection
            // (from a file, tool result, or web page) could try to pin and then
            // repeatedly re-read a file the user never asked for. Every model-driven
            // pin requires explicit user consent, and is refused outright when no
            // confirmation UI is available. Only direct `/pin` invocation by the user
            // bypasses this gate.
            const target = resolveFilePin(result.pin, invocation.sessionId);
            // The confirm prompt (shown to the user) uses the full absolute path so
            // they can see exactly which file is being pinned; the refuse message
            // (returned to the model) uses the stored/display path to avoid leaking
            // the home dir/username for session-rooted pins.
            const displayTarget = toStoredPath(target, invocation.sessionId);
            const gate = await confirmModelAction(
                `Allow Copilot to pin this file and re-read it into context every prompt?\n${target}`,
                `Refused: pinning a file needs confirmation, which isn't available here. The user can pin it explicitly with /pin add ${fmtPath(`@${displayTarget}`)}`,
            );
            if (!gate.ok) {
                return gate.message;
            }
            const status = await addPinToStore(invocation.sessionId, result.pin);
            return status.message;
        },
    },
    {
        name: "pin_prompt",
        skipPermission: true,
        defer: "never",
        description:
            "Pin an instruction into the current Copilot session so it is injected into every subsequent prompt. Use to make a directive, decision, or reminder persistent for the rest of the session.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The instruction to pin (also accepted as 'prompt').",
                },
            },
        },
        handler: async (args, invocation) => {
            const text = String(
                args?.text ?? args?.prompt ?? args?.instruction ?? args?.message ?? "",
            ).trim();
            if (!text) {
                return "No instruction text was provided. Pass the instruction in the 'text' argument.";
            }
            // Security gate: like pin_file, this tool is model-initiated. A
            // prompt-injection could persist a malicious standing instruction into
            // every subsequent turn. Require explicit user consent, and refuse when
            // no confirmation UI is available. Direct `/pin` invocation is unaffected.
            const gate = await confirmModelAction(
                `Allow Copilot to pin this instruction into every subsequent prompt this session?\n${shortText(text)}`,
                `Refused: pinning an instruction needs confirmation, which isn't available here. The user can pin it explicitly with /pin add ${shortText(text)}`,
            );
            if (!gate.ok) {
                return gate.message;
            }
            const status = await addPinToStore(invocation.sessionId, makePromptPin(text));
            return status.message;
        },
    },
    {
        name: "list_pins",
        skipPermission: true,
        defer: "never",
        description:
            "List the pins currently active in this Copilot session (prompt pins and live file pins), each with its id, type, and enabled/disabled state. Enabled pins show a short content/path preview; disabled pins are shown WITHOUT their content (they are intentionally silenced). Call this before removing or suppressing a specific pin so you can reference its id, or when diagnosing unexpected behavior to check whether a pinned instruction or file is interfering.",
        parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => {
            const store = await loadStore(invocation.sessionId);
            if (store.pins.length === 0) {
                return "No pins are set for this session.";
            }
            return store.pins
                .map((pin, index) => {
                    const head = `${index + 1}. [${pin.id}] (${isEnabled(pin) ? "enabled" : "disabled"}) ${pin.type}`;
                    // Redact the content/path of disabled pins: the user silenced
                    // them, so an ungated model-callable tool must not become an
                    // exfiltration path for their contents.
                    if (!isEnabled(pin)) {
                        return `${head}: [content hidden — pin is disabled]`;
                    }
                    return pin.type === "prompt"
                        ? `${head}: ${shortText(pin.text)}`
                        : `${head}: ${fmtPath(toStoredPath(resolveFilePin(pin, invocation.sessionId), invocation.sessionId))}`;
                })
                .join("\n");
        },
    },
    {
        name: "unpin",
        skipPermission: true,
        defer: "never",
        description:
            "Remove ONE pin from this Copilot session, identified by its id (preferred), its 1-based number from list_pins, or a text/path substring to match. Call list_pins first to get ids. Use when the user asks to remove or unpin a specific pin.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "The pin id to remove (from list_pins)." },
                index: {
                    type: "integer",
                    description: "1-based position of the pin as shown by list_pins.",
                },
                match: {
                    type: "string",
                    description:
                        "Substring to match against a prompt pin's text or a file pin's path.",
                },
            },
        },
        handler: async (args, invocation) => {
            const store = await loadStore(invocation.sessionId);
            if (store.pins.length === 0) {
                return "No pins to remove.";
            }

            let index = -1;
            if (args?.id) {
                index = store.pins.findIndex((p) => p.id === args.id);
            } else if (Number.isInteger(args?.index)) {
                index = args.index - 1;
            } else if (args?.match) {
                const needle = String(args.match).toLowerCase();
                index = store.pins.findIndex((p) => {
                    // Only substring-match ENABLED pins. Disabled pins are
                    // content-redacted in list_pins, so letting `match` search their
                    // text/path would turn unpin into a probing oracle for hidden
                    // content. Disabled pins can still be removed by id or index.
                    if (!isEnabled(p)) {
                        return false;
                    }
                    const hay =
                        p.type === "prompt"
                            ? p.text
                            : `${p.path} ${resolveFilePin(p, invocation.sessionId)}`;
                    return hay.toLowerCase().includes(needle);
                });
            } else {
                return "Specify which pin to remove by id, index, or match. Call list_pins first.";
            }

            if (index < 0 || index >= store.pins.length) {
                return "No matching pin found. Call list_pins to see the current pins.";
            }

            const victim = store.pins[index];
            const victimLabel =
                victim.type === "prompt"
                    ? shortText(victim.text)
                    : fileLabel(victim, invocation.sessionId);
            // Consent gate: this tool is model-initiated, so a prompt-injection could
            // try to silently delete a user's pinned guardrail. Require explicit
            // confirmation, and refuse when no UI is available.
            const gate = await confirmModelAction(
                `Allow Copilot to remove this ${victim.type} pin?\n${victimLabel}`,
                `Refused: removing a pin needs confirmation, which isn't available here. The user can remove it with /pin remove.`,
            );
            if (!gate.ok) {
                return gate.message;
            }

            const [removed] = store.pins.splice(index, 1);
            await saveStore(invocation.sessionId, store);
            // Don't echo a disabled pin's content back to the model — disabled pins
            // are content-redacted elsewhere (list_pins), so report by id only.
            if (!isEnabled(removed)) {
                return `Removed disabled ${removed.type} pin [${removed.id}].`;
            }
            return `Removed ${removed.type} pin: ${
                removed.type === "prompt"
                    ? shortText(removed.text)
                    : fileLabel(removed, invocation.sessionId)
            }`;
        },
    },
    {
        name: "clear_pins",
        skipPermission: true,
        defer: "never",
        description:
            "Remove ALL pins from this Copilot session. Use only when the user explicitly asks to clear, reset, or remove all pins.",
        parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => {
            const store = await loadStore(invocation.sessionId);
            const count = store.pins.length;
            if (count === 0) {
                return "No pins to clear.";
            }
            // Consent gate: model-initiated wipe of every pin — a prompt-injection
            // could use it to erase all of the user's pinned guardrails at once.
            const gate = await confirmModelAction(
                `Allow Copilot to remove ALL ${count} session pin${count === 1 ? "" : "s"}?`,
                `Refused: clearing all pins needs confirmation, which isn't available here. The user can clear them with /pin clear.`,
            );
            if (!gate.ok) {
                return gate.message;
            }
            store.pins = [];
            await saveStore(invocation.sessionId, store);
            return `Cleared ${count} pin${count === 1 ? "" : "s"}.`;
        },
    },
    {
        name: "test_without_pin",
        skipPermission: true,
        defer: "never",
        description:
            "Diagnostics only: temporarily omit ONE pin from just your NEXT turn to test whether it is causing a problem. The pin is automatically restored the turn after — this never changes the pin's saved enabled/disabled state and is never written to disk, so it cannot get 'stuck off' even if you are interrupted. Identify the pin by id (from list_pins). After calling this, re-run the failing step on your next turn and compare. Only the user can permanently enable/disable a pin (via the /pin pinboard); you cannot.",
        parameters: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description: "The id of the pin to omit from the next turn (from list_pins).",
                },
            },
        },
        handler: async (args, invocation) => {
            const id = String(args?.id ?? "").trim();
            if (!id) {
                return "Pass the id of the pin to omit (see list_pins).";
            }
            const store = await loadStore(invocation.sessionId);
            const pin = store.pins.find((p) => p.id === id);
            if (!pin) {
                return `No pin with id ${id}. Call list_pins to see the current pins.`;
            }
            if (!isEnabled(pin)) {
                return `Pin ${id} is already disabled, so it isn't being injected — nothing to suppress.`;
            }
            const label =
                pin.type === "prompt"
                    ? shortText(pin.text)
                    : fileLabel(pin, invocation.sessionId);
            // Consent gate: omitting a pin — even for one turn — can sidestep a
            // user-pinned constraint, so a prompt-injection could use it to bypass a
            // guardrail for a critical step. Require explicit confirmation.
            const gate = await confirmModelAction(
                `Allow Copilot to omit this ${pin.type} pin from the next turn (a one-off diagnostic; it is restored afterward)?\n${label}`,
                `Refused: suppressing a pin needs confirmation, which isn't available here.`,
            );
            if (!gate.ok) {
                return gate.message;
            }
            suppressOnce(invocation.sessionId, id);
            return (
                `Will omit pin ${id} (${label}) from your NEXT turn only; it is automatically ` +
                "re-injected the turn after, and its saved state is unchanged. Re-run the failing " +
                "step on your next turn to see whether this pin was the cause."
            );
        },
    },
];

const session = await joinSession({
    tools,
    commands: [
        {
            name: "pin",
            description:
                "Manage session pins: /pin add <text|@path>, list, edit, remove, clear.",
            handler: handlePin,
        },
    ],
    hooks: {
        onUserPromptSubmitted: async (input, invocation) => {
            // Best-effort: never let a pins failure disrupt the prompt pipeline.
            try {
                const additionalContext = await renderPinnedContext(invocation.sessionId);
                return additionalContext ? { additionalContext } : undefined;
            } catch (error) {
                await session.log(`session-pins: failed to inject pins: ${error.message}`, {
                    level: "warning",
                    ephemeral: true,
                });
                return undefined;
            }
        },
    },
});
