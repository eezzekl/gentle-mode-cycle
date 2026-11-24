// The permission modes gentle-shell knows, and the rotation this extension applies.
// gentle-shell keeps MODE_CHOICES private (lib/yolo-session-policy.ts), so the list
// lives here as well and has to be updated when gentle-shell changes it.

/** Every mode gentle-shell can be in. */
export const MODES = ["normal", "auto", "yolo", "super-yolo"] as const;
export type Mode = (typeof MODES)[number];

/** The default rotation: super-yolo stays out unless the user opts in. */
export const ROTATION = ["normal", "auto", "yolo"] as const;

/** A mode is usable only when it is one this extension knows. */
export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * The mode one press moves to, counted from the mode the session is in now.
 * An excluded super-yolo is not in the rotation at all, so it falls back to
 * normal: leaving the most permissive mode never lands on a more permissive one.
 */
export function nextMode(current: Mode, includeSuperYolo = false): Mode {
	const rotation: readonly Mode[] = includeSuperYolo ? MODES : ROTATION;
	const index = rotation.indexOf(current);
	if (index === -1) return "normal";
	return rotation[(index + 1) % rotation.length] ?? "normal";
}
