// The messages the user reads. Kept together so they stay stable and reusable.
import type { Mode } from "./modes.ts";

/** Written on a press that changed the mode, like gentle-shell's own mode notice. */
export function changedNotice(mode: Mode): string {
	return `Permissions: ${mode.toUpperCase()}`;
}

/** Written when gentle-shell refused the change; never a success notice. */
export function unchangedNotice(mode: Mode): string {
	return `Permission mode unchanged: still ${mode.toUpperCase()}.`;
}

/** Written when gentle-shell reports a mode this extension does not know. */
export function unknownModeNotice(mode: unknown): string {
	return `Unknown permission mode ${JSON.stringify(String(mode))}. No change made.`;
}

/** Written when gentle-shell did not answer the discovery channel. */
export function unavailableNotice(): string {
	return "gentle-shell is not available: cannot rotate the permission mode.";
}

/** Written when gentle-shell did not answer but /gentle:yolo exists, and that command is opened instead. */
export function fallbackNotice(): string {
	return "gentle-shell did not answer: opening /gentle:yolo instead.";
}

/** Written when gentle-shell did not settle within the rotation budget. */
export function timeoutNotice(): string {
	return "gentle-shell did not answer in time: the permission mode may not have changed.";
}

/** Written on session start when the config file holds an unusable key; alt+m is registered instead. */
export function invalidKeyNotice(value: unknown, reason: string, configFile: string): string {
	return `gentle-mode-cycle: the key ${JSON.stringify(value)} in ${configFile} is not usable (${reason}). Using alt+m.`;
}

/** Written on session start when the config file exists but is not a JSON object. */
export function malformedConfigNotice(configFile: string): string {
	return `gentle-mode-cycle: ${configFile} could not be read as a JSON object. Using the defaults (key alt+m).`;
}

/** Written after /mode-cycle key saved a key; Pi registers shortcuts only at load. */
export function keySavedNotice(shortcut: string | null): string {
	const what = shortcut === null ? "No shortcut will be registered (the /mode-cycle command keeps working)" : `Key saved: ${shortcut}`;
	return `${what}. Run /reload to apply it, and /hotkeys to check for conflicts.`;
}

/** Written when /mode-cycle key got a key that cannot work. */
export function keyRejectedNotice(value: string, reason: string): string {
	return `Key ${JSON.stringify(value)} not saved: ${reason}. Use modifiers plus one key, e.g. alt+m or ctrl+shift+k; "off" registers no key.`;
}

/** Written when the config file could not be written. */
export function saveFailedNotice(configFile: string, error: unknown): string {
	return `Could not save ${configFile}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Written by /mode-cycle status. */
export function statusNotice(details: { shortcut: string | null; pending?: string | null; includeSuperYolo: boolean; configFile: string }): string {
	const active = details.shortcut ?? "off (no shortcut)";
	const pending = details.pending === undefined ? "" : ` (the file now says ${details.pending ?? "off"}; run /reload)`;
	return [
		`Key: ${active}${pending}`,
		`super-yolo: ${details.includeSuperYolo ? "included" : "not included"} in the rotation`,
		`Config file: ${details.configFile}`,
	].join("\n");
}

/** Written for an unknown /mode-cycle subcommand; nothing is rotated. */
export function usageNotice(): string {
	return "Usage: /mode-cycle (rotate) | /mode-cycle key <key|off> | /mode-cycle status";
}
