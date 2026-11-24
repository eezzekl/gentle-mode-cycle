// The extension's own config file, `gentle-mode-cycle.json`, in Pi's agent directory.
// It is a file and not an environment variable because the self-contained
// gentle-shell launches Pi with a clean environment.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "gentle-mode-cycle.json";
export const DEFAULT_KEY = "alt+m";

export type ConfigFile = Record<string, unknown>;

/**
 * Pi's agent directory, where this extension's config file lives. Pi resolves it as
 * PI_CODING_AGENT_DIR (with `~` expanded) or `~/.pi/agent` — the same code in both Pi
 * versions this extension supports — so it is mirrored here. Importing the host
 * package at load time to call its `getAgentDir()` would pull a second copy of Pi into
 * the extension host and resolve the very same path.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured) return expandHome(configured);
	return join(homedir(), ".pi", "agent");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export interface ReadResult {
	/** The parsed object; empty when the file is missing or malformed. */
	values: ConfigFile;
	/** True when the file exists but is not a JSON object. */
	malformed: boolean;
}

/** Read on every use, so a saved change applies without a restart. Never throws. */
export function readConfig(agentDir: string): ReadResult {
	let text: string;
	try {
		text = readFileSync(configPath(agentDir), "utf8");
	} catch (error) {
		// A missing file is the normal first-run case; any other read failure is as unusable as a bad file.
		const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
		return { values: {}, malformed: !missing };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { values: parsed as ConfigFile, malformed: false };
		}
	} catch {
		// malformed: handled below
	}
	return { values: {}, malformed: true };
}

/** Merge `patch` into the file, keeping every other field (later tasks add more). Throws on write failure. */
export function writeConfig(agentDir: string, patch: ConfigFile): void {
	const next = { ...readConfig(agentDir).values, ...patch };
	mkdirSync(agentDir, { recursive: true });
	const target = configPath(agentDir);
	const temp = `${target}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(temp, target);
}

const MODIFIERS = ["ctrl", "alt", "shift", "super"];
const NAMED_KEYS = [
	"escape", "esc", "enter", "tab", "space", "backspace", "delete", "insert",
	"home", "end", "pageup", "pagedown", "up", "down", "left", "right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];
// Terminals send these control combinations as other keys.
const TERMINAL_CLASHES: Record<string, string> = {
	m: "Enter (carriage return)",
	i: "Tab",
	j: "line feed",
};

export type KeyCheck =
	| { ok: true; /** Normalized key, or null when the user asked for no shortcut. */ key: string | null }
	| { ok: false; reason: string };

/**
 * Pi performs no key validation, so an invalid key would be registered silently
 * and never fire. Accept "off"/"" (no shortcut) or modifiers plus one base key.
 */
export function validateKey(raw: unknown): KeyCheck {
	if (typeof raw !== "string") return { ok: false, reason: "the key must be text" };
	const value = raw.trim().toLowerCase();
	if (value === "" || value === "off") return { ok: true, key: null };
	const parts = value.split("+");
	if (parts.some((part) => part === "")) return { ok: false, reason: "it is malformed" };
	const base = parts[parts.length - 1] as string;
	const modifiers = parts.slice(0, -1);
	if (MODIFIERS.includes(base)) return { ok: false, reason: "it has no base key" };
	if (modifiers.length === 0) return { ok: false, reason: "it needs a modifier (ctrl, alt, shift or super)" };
	if (modifiers.some((modifier) => !MODIFIERS.includes(modifier))) return { ok: false, reason: "it has an unknown modifier" };
	if (new Set(modifiers).size !== modifiers.length) return { ok: false, reason: "a modifier is repeated" };
	const single = [...base].length === 1 && base.trim() !== "";
	if (!single && !NAMED_KEYS.includes(base)) return { ok: false, reason: "the base key is not recognized" };
	if (modifiers.length === 1 && modifiers[0] === "ctrl" && base in TERMINAL_CLASHES) {
		return { ok: false, reason: `terminals send ctrl+${base} as ${TERMINAL_CLASHES[base]}` };
	}
	return { ok: true, key: value };
}

export interface ResolvedConfig {
	/** The key to register; null means register none. */
	shortcut: string | null;
	/** Set when the file held an invalid key and the default was used instead. */
	invalid?: { value: unknown; reason: string };
	malformed: boolean;
	includeSuperYolo: boolean;
	/** Show the success notice on a press that changed the mode. Default true; warnings are never hidden. */
	notify: boolean;
	/** Ring the terminal bell when a press lands on normal. Default true. */
	bellOnNormal: boolean;
}

/** The effective settings: defaults wherever the file is missing, malformed or invalid. */
export function resolveConfig(agentDir: string): ResolvedConfig {
	const { values, malformed } = readConfig(agentDir);
	const includeSuperYolo = values.includeSuperYolo === true;
	// Anything but a real boolean keeps the default (on).
	const notify = typeof values.notify === "boolean" ? values.notify : true;
	const bellOnNormal = typeof values.bellOnNormal === "boolean" ? values.bellOnNormal : true;
	const flags = { malformed, includeSuperYolo, notify, bellOnNormal };
	if (!("key" in values)) return { shortcut: DEFAULT_KEY, ...flags };
	const check = validateKey(values.key);
	if (check.ok) return { shortcut: check.key, ...flags };
	return { shortcut: DEFAULT_KEY, invalid: { value: values.key, reason: check.reason }, ...flags };
}
