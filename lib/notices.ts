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
