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
// Pins live inside the session folder — session.workspacePath when available,
// otherwise <COPILOT_HOME, or ~/.copilot>/session-state/<id> — so they travel with
// the session and are cleaned up when the session is deleted.

import { joinSession } from "@github/copilot-sdk/extension";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const stores = new Map();
// Assigned once joinSession() resolves (declared here so helpers like sessionDir
// can reference it defensively — session?.workspacePath — without a TDZ error if
// any SDK preflight path touches them before the session is ready).
let session;
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
// pin_list tool, and log lines). Kept in one place so every preview truncates
// at the same, generous length.
const PREVIEW_LENGTH = 240;

// Max bytes of a pinned file injected into a prompt. Larger files are truncated
// with a notice so an accidentally-pinned huge file can't blow up the context.
const MAX_PINNED_FILE_BYTES = 64 * 1024;
// Generous, non-blocking advisory threshold: when all active pins together add
// more than this to every prompt, pin_list / the startup notice mention it. This
// never blocks pinning — it's purely a heads-up about context cost.
const SOFT_PIN_BUDGET_BYTES = 200 * 1024;

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
        // that contain a ".." segment (same rule as input-time hasRelativeTraversal).
        // (Absolute pins are an intentional feature for files outside the session.)
        if (hasRelativeTraversal(pin.path)) {
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
// Expand a leading ~ (~, ~/, ~\) to the user's home directory, since neither
// path.resolve nor the shell expands ~ when it arrives from an env var or picker.
function expandTilde(value) {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return join(homedir(), value.slice(2));
    }
    return value;
}

function copilotHome() {
    const configured = process.env.COPILOT_HOME?.trim();
    return configured ? expandTilde(configured) : join(homedir(), ".copilot");
}

function sessionDir(sessionId) {
    return session?.workspacePath ?? join(copilotHome(), "session-state", safeId(sessionId));
}

// The root for session-level user files (<session>/files). Session file pins are
// stored relative to this, and typed relative paths resolve against it.
function sessionFilesDir(sessionId) {
    return join(sessionDir(sessionId), SESSION_FILES_SUBDIR);
}

// Windows and macOS default to case-insensitive filesystems, but path.relative()
// compares case-sensitively on posix (macOS). So a file genuinely under
// <session>/files whose absolute path differs only by casing could be
// misclassified as "outside" and stored/displayed as an absolute path — leaking
// the session/home path into every injected prompt. Retry the containment check
// case-insensitively on those platforms.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

// True when a path produced by relative(base, target) keeps target inside base.
// Only a leading ".." *segment* means "outside" — a filename that merely starts
// with dots (e.g. "..notes.md") is still inside.
function relativeStaysInside(rel) {
    if (rel === "") {
        return true;
    }
    if (isAbsolute(rel)) {
        return false;
    }
    return rel.split(/[\\/]/)[0] !== "..";
}

// True when two absolute paths point at the same file. Uses resolve() to collapse
// redundant segments/separators, and folds case on case-insensitive filesystems
// (Windows/macOS) so "Notes.md" and "notes.md" aren't treated as distinct pins.
function samePath(a, b) {
    let pa = resolve(a);
    let pb = resolve(b);
    if (CASE_INSENSITIVE_FS) {
        pa = pa.toLowerCase();
        pb = pb.toLowerCase();
    }
    return pa === pb;
}

// Relative path of absolutePath within baseDir when it is inside, otherwise null.
function insideRelative(baseDir, absolutePath) {
    if (!baseDir) {
        return null;
    }
    const rel = relative(baseDir, absolutePath);
    if (relativeStaysInside(rel)) {
        return rel;
    }
    if (CASE_INSENSITIVE_FS) {
        // On win32 the first relative() is already case-insensitive; this retry
        // is what covers macOS. The folded relative is safe to read/store on a
        // case-insensitive filesystem.
        const relCI = relative(baseDir.toLowerCase(), absolutePath.toLowerCase());
        if (relativeStaysInside(relCI)) {
            return relCI;
        }
    }
    return null;
}

// How a resolved absolute path is stored: relative to the session files folder
// when it lives inside it (session-rooted), otherwise the absolute path.
function toStoredPath(absolutePath, sessionId) {
    const base = sessionFilesDir(sessionId);
    const rel = insideRelative(base, absolutePath);
    if (rel !== null) {
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

// A relative input path is contractually rooted at <session>/files, so a ".."
// segment would let it escape that folder and be stored as an absolute pin —
// bypassing the load-time traversal guard (which only rejects "..") in stored
// relative paths). Reject relative traversal at input time; pinning an
// outside-session file requires an explicit absolute path.
function hasRelativeTraversal(rawPath) {
    return !isAbsolute(rawPath) && rawPath.split(/[\\/]/).includes("..");
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
                    `session-pins: ignoring unreadable pin store (${error?.code ?? error?.name ?? "unknown error"}); starting empty.`,
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
        try {
            await rename(temporaryPath, path);
        } catch (error) {
            // Best-effort: if the rename fails (e.g. a transient AV/permissions lock
            // on Windows), don't leave the temp file littering the session folder.
            try { await rm(temporaryPath, { force: true }); } catch {}
            throw error;
        }
        // Best-effort: on POSIX, fsync the parent directory so the rename itself
        // (the directory-entry update) is durable, not just the file contents —
        // otherwise a crash right after rename could still lose the update. Opening
        // a directory for sync isn't supported on Windows (rename durability there
        // is handled by MoveFileEx), so any error is swallowed.
        try {
            const directoryHandle = await open(dirname(path), "r");
            try {
                await directoryHandle.sync();
            } finally {
                await directoryHandle.close();
            }
        } catch {}
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
// <prompt_pin> / <live_file_pin> wrapper boundaries (defense against a pinned
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
    const display = pinPathDisplay(pin, sessionId);
    return `${mark} ${number} @${display}`;
}

// Build pinboard / list labels with a per-file cost suffix, plus the running total
// bytes across ENABLED pins (what's actually injected each prompt). File pins show
// their approximate injected size; prompt pins are tiny and show none. Disabled
// pins are silenced, so they add nothing to the total and get no cost suffix.
async function buildLabeledPins(store, sessionId) {
    let totalBytes = 0;
    const labels = [];
    for (let index = 0; index < store.pins.length; index++) {
        const pin = store.pins[index];
        let suffix = "";
        if (pin.type === "file") {
            // A missing file (not yet created, or moved/deleted) is flagged so a
            // typo or a never-created optimistic pin is visible — shown whether the
            // pin is enabled or not, since it's a status signal, not file content.
            if (!(await filePinExists(pin, sessionId))) {
                suffix = " (not found)";
            } else if (isEnabled(pin)) {
                const bytes = await pinBytes(pin, sessionId);
                totalBytes += bytes;
                suffix = ` (~${formatBytes(bytes)})`;
            }
        } else if (isEnabled(pin)) {
            totalBytes += await pinBytes(pin, sessionId);
        }
        labels.push(pinLabel(pin, index, sessionId) + suffix);
    }
    return { labels, totalBytes };
}

// One-line running-total summary shown in the pinboard title and the /pin list
// footer. Bytes only — an exact figure, rather than a fake-precise token estimate.
function pinTotalSummary(totalBytes) {
    return `\u2248 ${formatBytes(totalBytes)} added to every prompt`;
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
    value = expandTilde(value);

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
        if (hasRelativeTraversal(rawPath)) {
            return {
                ok: false,
                error: "A relative pin path can't contain '..' (it's rooted at the session files folder). Pass an absolute path to pin a file outside the session.",
            };
        }

        // Session-rooted: a relative path resolves against the session files
        // folder; an absolute path is used as-is.
        const absolutePath = resolveInputPath(rawPath, sessionId);
        let info;
        try {
            info = await stat(absolutePath);
        } catch (error) {
            // A not-yet-existing file is allowed: the model may create the file
            // and pin it as parallel tool calls in one turn, so pin_file's stat
            // can run before the create's write lands. Rather than fail (or wait),
            // pin optimistically and mark it missing — the pinboard/list flag it as
            // "(not found)" and the per-prompt render reads it once it exists (which,
            // for a concurrent create, is the very next prompt). Only ENOENT is
            // tolerated; any other fs error (e.g. EACCES) is a genuine problem.
            if (error?.code === "ENOENT") {
                return {
                    ok: true,
                    missing: true,
                    pin: makeFilePin(toStoredPath(absolutePath, sessionId)),
                };
            }
            return {
                ok: false,
                error: `Can't pin ${fileDescriptor(absolutePath, sessionId)}: ${fsErrorReason(error)}.`,
            };
        }
        if (!info.isFile()) {
            return {
                ok: false,
                error: `Can't pin ${fileDescriptor(absolutePath, sessionId)}: it isn't a file.`,
            };
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
        const dupIndex = store.pins.findIndex(
            (p) => p.type === "file" && samePath(resolveFilePin(p, sessionId), target),
        );
        if (dupIndex >= 0) {
            return {
                added: false,
                message: `Already pinned as pin ${dupIndex + 1}: ${pinDescriptor(store.pins[dupIndex], sessionId)}.`,
            };
        }
    }
    store.pins.push(pin);
    // Capture this pin's number before awaiting: pins are only ever appended, so
    // the index is stable, but store.pins.length could change if a concurrent add
    // on the shared store runs during the save await.
    const pinNumber = store.pins.length;
    await saveStore(sessionId, store);
    return {
        added: true,
        message: `Pinned pin ${pinNumber}: ${pinDescriptor(pin, sessionId)}.`,
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

// The display path of a file pin, without formatting (for the pinboard and picker
// labels that add their own `@` prefix). Returns a session-relative path for files
// inside <session>/files, absolute only for files that genuinely live elsewhere.
function pinPathDisplay(pin, sessionId) {
    return toStoredPath(resolveFilePin(pin, sessionId), sessionId);
}

// A safe reason string for a filesystem error. Node's fs error messages embed the
// absolute path (e.g. "ENOENT: no such file or directory, stat '<abs>'"), which
// would leak the session/home path into model-visible output, so report only the
// error code.
function fsErrorReason(error) {
    return error?.code ? `error code ${error.code}` : "an unknown error";
}

// One consistent way to describe a pin in a message: a prompt shows as its text in
// double quotes, a file shows as `@path` — matching how you type `/pin add @path`
// and the pinboard labels. Paths go through fmtPath so spaces/backticks stay safe,
// and through the session-rooted display transform so the absolute session/home
// path is never leaked for a session-rooted file.
function pinDescriptor(pin, sessionId) {
    return pin.type === "prompt"
        ? `"${shortText(pin.text)}"`
        : fmtPath(`@${pinPathDisplay(pin, sessionId)}`);
}

// The `@path` descriptor for a file given its absolute path (used before the pin is
// built/stored). Same display transform, so no absolute-path leak.
function fileDescriptor(absolutePath, sessionId) {
    return fmtPath(`@${toStoredPath(absolutePath, sessionId)}`);
}

// Human-readable byte size for the pin-file consent prompt, so the user sees the
// per-turn context cost of pinning a live file before approving.
function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "unknown size";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Very rough token estimate (~4 bytes/token) for the pin-cost readout. Only used
// for an at-a-glance "how much context do my pins cost" figure, never for limits.
function approxTokens(bytes) {
    return Math.ceil(bytes / 4);
}

// Approximate bytes a pin adds to each prompt: the prompt text, or the file's
// on-disk size capped at the injection cap (larger files are truncated on inject).
// Best-effort — an unreadable file counts as 0.
async function pinBytes(pin, sessionId) {
    if (pin.type === "prompt") {
        return Buffer.byteLength(String(pin.text ?? ""), "utf8");
    }
    try {
        const { size } = await stat(resolveFilePin(pin, sessionId));
        return Math.min(size, MAX_PINNED_FILE_BYTES);
    } catch {
        return 0;
    }
}

// Does a file pin's target currently exist on disk as a readable file? Used to flag
// "(not found)" in the pinboard / list for a pin whose file is missing — either a
// not-yet-created file (pinned optimistically to avoid the create/pin race) or a
// stale pin whose file was moved/deleted. Best-effort: any error counts as missing.
async function filePinExists(pin, sessionId) {
    try {
        return (await stat(resolveFilePin(pin, sessionId))).isFile();
    } catch {
        return false;
    }
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
        await session.log(`Updated pin ${index + 1}: "${shortText(text)}".`, { level: "info" });
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
    if (hasRelativeTraversal(cleaned)) {
        await session.log(
            "A relative pin path can't contain '..' (it's rooted at the session files folder). Pass an absolute path to pin a file outside the session.",
            { level: "error" },
        );
        return;
    }

    const absolutePath = resolveInputPath(cleaned, ctx.sessionId);
    if (samePath(absolutePath, resolveFilePin(pin, ctx.sessionId))) {
        return;
    }

    const duplicate = store.pins.some(
        (p) => p !== pin && p.type === "file" && samePath(resolveFilePin(p, ctx.sessionId), absolutePath),
    );
    if (duplicate) {
        await session.log(`Already pinned: ${fileDescriptor(absolutePath, ctx.sessionId)}.`, { level: "info" });
        return;
    }

    let missing = false;
    try {
        const info = await stat(absolutePath);
        if (!info.isFile()) {
            await session.log(`Can't pin ${fileDescriptor(absolutePath, ctx.sessionId)}: it isn't a file.`, { level: "error" });
            return;
        }
    } catch (error) {
        // Consistent with pin_file: a not-yet-existing target is allowed (flagged
        // "(not found)" in the pinboard); any other fs error is a genuine problem.
        if (error?.code !== "ENOENT") {
            await session.log(`Can't pin ${fileDescriptor(absolutePath, ctx.sessionId)}: ${fsErrorReason(error)}.`, { level: "error" });
            return;
        }
        missing = true;
    }

    pin.path = toStoredPath(absolutePath, ctx.sessionId);
    await saveStore(ctx.sessionId, store);
    const note = missing ? ' (not found yet — shows as "(not found)" until the file exists)' : "";
    await session.log(`Updated pin ${index + 1}: ${fileDescriptor(absolutePath, ctx.sessionId)}.${note}`, { level: "info" });
}

async function deletePin(ctx, store, index) {
    const pin = store.pins[index];
    if (!pin) {
        return false;
    }
    if (elicitationEnabled()) {
        const confirmed = await session.ui.confirm(`Unpin pin ${index + 1}: ${pinDescriptor(pin, ctx.sessionId)}?`);
        if (!confirmed) {
            return false;
        }
    }
    store.pins.splice(index, 1);
    await saveStore(ctx.sessionId, store);
    await session.log(`Unpinned pin ${index + 1}: ${pinDescriptor(pin, ctx.sessionId)}.`, { level: "info" });
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
        const { labels: pinItems, totalBytes } = await buildLabeledPins(store, ctx.sessionId);
        const title = store.pins.length
            ? `Session pins — ${pinTotalSummary(totalBytes)}`
            : "No pins yet";
        const choice = await choose(title, [...pinItems, ADD]);

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
                    : `@${pinPathDisplay(selected, ctx.sessionId)}`;
            const toggleLabel = isEnabled(selected) ? "Disable" : "Enable";
            // "Open" (file pins only) hands the file off to the agent to open in an
            // editor however it chooses; a prompt pin has no file to open.
            const options =
                selected.type === "file"
                    ? ["Open", "Edit", toggleLabel, "Delete"]
                    : ["Edit", toggleLabel, "Delete"];
            const action = await choose(detail, options);

            if (action === null) {
                break;
            }
            if (action === "Open") {
                const target = resolveFilePin(selected, ctx.sessionId);
                await session.send(`Open this file in an editor: ${target}`);
                await session.log(
                    `Asked Copilot to open pin ${index + 1}: ${pinDescriptor(selected, ctx.sessionId)}.`,
                    { level: "info" },
                );
                // Close the pinboard so the agent can act on the open request.
                return;
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
    const { labels, totalBytes } = await buildLabeledPins(store, ctx.sessionId);
    const lines = labels.map((label) => `  ${label}`);
    await session.log(
        `Session pins:\n${lines.join("\n")}\n\n${pinTotalSummary(totalBytes)}`,
        { level: "info" },
    );
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
        const confirmed = await session.ui.confirm(`Clear all ${store.pins.length} pins?`);
        if (!confirmed) {
            return;
        }
    }
    const count = store.pins.length;
    store.pins = [];
    await saveStore(ctx.sessionId, store);
    await session.log(`Cleared ${count} pin${count === 1 ? "" : "s"}.`, { level: "info" });
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

async function renderPinnedContext(sessionId) {
    const store = await loadStore(sessionId);
    const sections = [];
    for (let i = 0; i < store.pins.length; i++) {
        const pin = store.pins[i];
        // Skip disabled pins (saved but silenced); they stay in pins.json.
        if (!isEnabled(pin)) {
            continue;
        }
        // 1-based number matching pin_list and the /pin command, so the user and
        // model refer to a pin by the same identifier (the guid is never exposed).
        const number = i + 1;
        if (pin.type === "prompt") {
            sections.push(`<prompt_pin number="${number}">\n${escapeXml(pin.text)}\n</prompt_pin>`);
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
                `<live_file_pin number="${number}" path="${escapeXmlAttr(displayPath)}"${truncatedAttr}>\n${escapeXml(contents)}\n</live_file_pin>`,
            );
        } catch (error) {
            // A missing file (ENOENT) is expected for an optimistically-pinned file
            // that hasn't been created yet (or was moved/deleted): inject NOTHING so
            // we don't spam every prompt with an unreadable block. The pinboard and
            // /pin list already flag it as "(not found)". Any OTHER fs error (e.g.
            // EACCES — the file exists but can't be read) is a genuine problem, so
            // surface a compact notice. Report only the error code (never
            // error.message, which embeds the absolute path and would leak the home
            // dir/username; the path attribute already avoids this).
            if (error?.code === "ENOENT") {
                continue;
            }
            const reason = fsErrorReason(error);
            sections.push(
                `<live_file_pin number="${number}" path="${escapeXmlAttr(displayPath)}" unreadable="true">\n` +
                    `The pinned file could not be read (${escapeXml(reason)}).\n` +
                    `</live_file_pin>`,
            );
        }
    }

    if (sections.length === 0) {
        return undefined;
    }

    return [
        "<session_pins>",
        "The user pinned the following for this session — treat it as active instructions and apply it this turn.",
        ...sections,
        "</session_pins>",
    ].join("\n\n");
}

// Consent gate for model-initiated actions that add or remove pins.
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
// (pin_file / pin_prompt), inspect (pin_list), and remove (pin_remove / pin_clear).
const tools = [
    {
        name: "pin_file",
        skipPermission: true,
        defer: "never",
        description:
            "Pin a file so its current contents are re-read from disk and re-injected into every subsequent prompt until the user unpins it (up to the first 64 KB is injected; larger files are truncated). This persistently grows the context window and token use every turn, so avoid large files. Pin ONLY when the user explicitly asks to pin or keep a file in context; NEVER pin proactively or as a side effect of creating, showing, or editing a file. To show or open a file once, use the normal view/read tools — not a pin. This tool pins a file that ALREADY EXISTS on disk: if you need to create the file first, create it in a separate, earlier step and let that tool call finish, THEN call pin_file in a later step — do NOT issue the file-creating tool call and pin_file together in the same batch of tool calls, or pin_file may run before the file has been written. A relative path is resolved against the session's files folder; pass an absolute path for a file anywhere else (e.g. a file in the user's repo).",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the file to pin; the file must already exist (create it in a separate earlier step, not in the same batch as this call). Relative paths resolve against the session's files folder — pass just the file name (e.g. `notes.txt`, not `files/notes.txt`); use an absolute path for files outside it.",
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
            // Surface the file size so the user sees the per-turn context cost before
            // approving; a pinned file's full contents are re-injected every prompt.
            let sizeNote = "";
            if (result.missing) {
                sizeNote = " (file not found yet — it will be read into context once it exists)";
            } else {
                try {
                    sizeNote = ` (${formatBytes((await stat(target)).size)}, re-read into context every prompt until unpinned)`;
                } catch {
                    // Non-fatal: if the size can't be read now, just omit the note.
                }
            }
            const gate = await confirmModelAction(
                `Allow Copilot to pin this file${sizeNote}?\n${target}`,
                `Refused: pinning a file needs confirmation, which isn't available here. The user can pin it explicitly with /pin add ${fmtPath(`@${displayTarget}`)}`,
            );
            if (!gate.ok) {
                return gate.message;
            }
            const status = await addPinToStore(invocation.sessionId, result.pin);
            if (result.missing && status.added) {
                // Pinned optimistically: tell the model the file isn't there yet so it
                // creates it (in a separate step) rather than assuming the pin failed.
                return `${status.message} The file doesn't exist yet, so it shows as "(not found)" and nothing is injected until it exists — create it in a separate step if you haven't already.`;
            }
            return status.message;
        },
    },
    {
        name: "pin_prompt",
        skipPermission: true,
        defer: "never",
        description:
            "Pin an instruction so it is injected into every subsequent prompt for the rest of the session (until the user unpins it). Pin ONLY when the user explicitly asks to pin, keep, or remember a directive, decision, or rule; NEVER pin proactively or as a side effect of normal work. For a one-off reminder, just act on it — don't pin.",
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
        name: "pin_list",
        skipPermission: true,
        defer: "never",
        description:
            "List the pins currently active in this Copilot session (prompt pins and live file pins), each with its number and enabled/disabled state. Enabled pins show a short preview (prompts in double quotes, files as @path) and, for file pins, their approximate size; a running total shows how much is added to every prompt. Disabled pins are shown WITHOUT their content (they are intentionally silenced). Call this before removing a specific pin so you can reference its number, or when diagnosing unexpected behavior to check whether a pinned instruction or file is interfering.",
        parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => {
            const store = await loadStore(invocation.sessionId);
            if (store.pins.length === 0) {
                return "No pins are set for this session.";
            }
            const lines = [];
            let activeBytes = 0;
            for (let index = 0; index < store.pins.length; index++) {
                const pin = store.pins[index];
                const head = `${index + 1}. (${isEnabled(pin) ? "enabled" : "disabled"})`;
                // Redact the content/path of disabled pins: the user silenced them,
                // so an ungated model-callable tool must not become an exfiltration
                // path for their contents. Disabled pins add nothing to prompts.
                if (!isEnabled(pin)) {
                    lines.push(`${head} [content hidden — pin is disabled]`);
                    continue;
                }
                const bytes = await pinBytes(pin, invocation.sessionId);
                activeBytes += bytes;
                // Show the per-turn cost for file pins (prompt pins are tiny); the
                // total below covers everything injected.
                const cost = pin.type === "file" ? ` (~${formatBytes(bytes)})` : "";
                lines.push(`${head} ${pinDescriptor(pin, invocation.sessionId)}${cost}`);
            }
            let footer = `\n≈ ${formatBytes(activeBytes)} (~${approxTokens(activeBytes)} tokens) added to every prompt.`;
            if (activeBytes > SOFT_PIN_BUDGET_BYTES) {
                footer += ` That's a lot of context — consider unpinning or disabling large pins.`;
            }
            return lines.join("\n") + footer;
        },
    },
    {
        name: "pin_remove",
        skipPermission: true,
        defer: "never",
        description:
            "Remove ONE pin from this Copilot session, identified by its 1-based number from pin_list, or a text/path substring to match. Call pin_list first. Use when the user asks to remove or unpin a specific pin.",
        parameters: {
            type: "object",
            properties: {
                number: {
                    type: "integer",
                    description: "1-based pin number as shown by pin_list.",
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
            if (Number.isInteger(args?.number)) {
                index = args.number - 1;
            } else if (args?.match) {
                const needle = String(args.match).toLowerCase();
                index = store.pins.findIndex((p) => {
                    // Only substring-match ENABLED pins. Disabled pins are
                    // content-redacted in pin_list, so letting `match` search their
                    // text/path would turn pin_remove into a probing oracle for hidden
                    // content. Disabled pins can still be removed by number.
                    if (!isEnabled(p)) {
                        return false;
                    }
                    // Match file pins on their DISPLAY path only (session-relative
                    // for internal pins; absolute solely when the user pinned an
                    // external absolute path). Matching the resolved absolute path
                    // would turn `match` into an oracle for the hidden session/home
                    // path even though that path is never printed.
                    const hay =
                        p.type === "prompt"
                            ? p.text
                            : pinPathDisplay(p, invocation.sessionId);
                    return hay.toLowerCase().includes(needle);
                });
            } else {
                return "Specify which pin to remove by number or match. Call pin_list first.";
            }

            if (index < 0 || index >= store.pins.length) {
                return "No matching pin found. Call pin_list to see the current pins.";
            }

            const victim = store.pins[index];
            const victimLabel = pinDescriptor(victim, invocation.sessionId);
            // Consent gate: this tool is model-initiated, so a prompt-injection could
            // try to silently delete a user's pinned guardrail. Require explicit
            // confirmation, and refuse when no UI is available.
            const gate = await confirmModelAction(
                `Allow Copilot to unpin pin ${index + 1} (${victimLabel})?`,
                `Refused: removing a pin needs confirmation, which isn't available here. The user can remove it with /pin remove.`,
            );
            if (!gate.ok) {
                return gate.message;
            }

            const [removed] = store.pins.splice(index, 1);
            await saveStore(invocation.sessionId, store);
            // Don't echo a disabled pin's content back to the model — disabled pins
            // are content-redacted elsewhere (pin_list), so report by number only.
            if (!isEnabled(removed)) {
                return `Unpinned pin ${index + 1} (disabled).`;
            }
            return `Unpinned pin ${index + 1}: ${victimLabel}.`;
        },
    },
    {
        name: "pin_clear",
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
                `Allow Copilot to clear all ${count} pin${count === 1 ? "" : "s"}?`,
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
];

session = await joinSession({
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
                await session.log(`session-pins: failed to inject pins: ${error?.code ?? error?.name ?? "unknown error"}`, {
                    level: "warning",
                    ephemeral: true,
                });
                return undefined;
            }
        },
    },
});

// On session start, surface how many pins are active (like the CLI's "N plugins
// loaded" notice) so a resumed session's standing pins aren't invisible. Best-
// effort: never block or fail extension load.
try {
    const startupStore = await loadStore(session.sessionId);
    if (startupStore.pins.length > 0) {
        const active = startupStore.pins.filter(isEnabled);
        const disabled = startupStore.pins.length - active.length;
        let activeBytes = 0;
        for (const pin of active) {
            activeBytes += await pinBytes(pin, session.sessionId);
        }
        await session.log(
            `session-pins: ${active.length} pin${active.length === 1 ? "" : "s"} active` +
                (disabled ? ` (${disabled} disabled)` : "") +
                `, ≈ ${formatBytes(activeBytes)} added to every prompt — use /pin to view or manage.`,
            { level: "info" },
        );
    }
} catch {
    // best-effort startup notice; ignore any failure
}
