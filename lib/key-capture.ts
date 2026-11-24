// The capture box behind `/mode-cycle key` (no argument): the user presses the
// combination and the box shows it, instead of typing a notation that is easy to
// get wrong (`alt-n`, or shift+n meaning a capital letter).
import { validateKey } from "./config.ts";

/** The two pi-tui functions the box needs; the host supplies pi-tui at runtime. */
export interface KeyTools {
	parseKey(data: string): string | undefined;
	matchesKey(data: string, keyId: string): boolean;
}

/** The part of Pi's keybindings manager the box reads. */
export interface CaptureKeybindings {
	matches?(data: string, keybinding: string): boolean;
}

export interface KeyCaptureComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

export const CAPTURE_TITLE = "Press the key combination for the mode-cycle shortcut";
export const CAPTURE_HINT = "Backspace clears · Enter confirms · Escape cancels";
export const CAPTURE_EMPTY = "(waiting for a key)";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];

/**
 * Pi's key id form: lowercase, modifiers in the canonical order ctrl, shift, alt, super
 * (the same normalization gentle-shell uses for its keymaps). Undefined when malformed.
 */
export function normalizeKeyId(key: string): string | undefined {
	const parts = key.trim().toLowerCase().split("+");
	const base = parts.pop();
	if (!base) return undefined;
	const modifiers = new Set<string>();
	for (const part of parts) {
		if (!MODIFIER_ORDER.includes(part)) return undefined;
		modifiers.add(part);
	}
	return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), base].join("+");
}

/**
 * Import pi-tui only when the box is opened, so a host without it never breaks the
 * extension at load. Any failure means "no capture": the caller keeps the typed usage.
 */
export async function loadKeyTools(): Promise<KeyTools | undefined> {
	try {
		const tui = (await import("@earendil-works/pi-tui")) as Partial<KeyTools>;
		if (typeof tui.parseKey !== "function" || typeof tui.matchesKey !== "function") return undefined;
		return { parseKey: tui.parseKey, matchesKey: tui.matchesKey };
	} catch {
		return undefined;
	}
}

/**
 * A legacy terminal sends alt+<letter> as ESC followed by that letter, and pi-tui maps
 * some of those to arrows (ESC n → alt+down, ESC b → alt+left, ESC f → alt+right …).
 * The box shows what Pi sees, but binding that would bind an arrow instead of the
 * combination the user pressed, so the ambiguity is reported instead of accepted.
 * Returns the id the terminal reported, or undefined when the sequence is unambiguous.
 */
export function legacyAmbiguity(data: string, key: string): string | undefined {
	if (data.length !== 2 || data[0] !== "\x1b") return undefined;
	const letter = data[1]?.toLowerCase() ?? "";
	if (!/^[a-z]$/.test(letter)) return undefined;
	const base = key.split("+").pop();
	return base === letter ? undefined : key;
}

/**
 * `done(value)` closes the box: the normalized key on Enter, undefined on Escape.
 * Enter is refused while the captured combination is invalid.
 */
export function createKeyCapture(
	tools: KeyTools,
	keybindings: CaptureKeybindings | undefined,
	done: (value: string | undefined) => void,
): KeyCaptureComponent {
	let captured: string | undefined;
	let reason: string | undefined;
	let legacy: string | undefined;

	const is = (data: string, binding: string, fallbackKey: string): boolean => {
		try {
			if (typeof keybindings?.matches === "function") return keybindings.matches(data, binding);
			return tools.matchesKey(data, fallbackKey);
		} catch {
			return false;
		}
	};

	const capture = (data: string): void => {
		let parsed: string | undefined;
		try {
			parsed = tools.parseKey(data);
		} catch {
			parsed = undefined;
		}
		const key = parsed === undefined ? undefined : normalizeKeyId(parsed);
		if (key === undefined) return; // not a key the terminal can name: keep what was captured
		captured = key;
		legacy = legacyAmbiguity(data, key);
		const check = validateKey(key);
		reason = check.ok ? undefined : check.reason;
	};

	return {
		render(width: number): string[] {
			const shown = captured === undefined ? CAPTURE_EMPTY : captured;
			const lines = [CAPTURE_TITLE, "", `  ${shown}`];
			if (reason !== undefined) lines.push(`  Not usable: ${reason}.`);
			if (legacy !== undefined) {
				lines.push(`  Your terminal reported this as ${legacy} (a legacy sequence): it cannot name the combination you pressed. Try another combination.`);
			}
			lines.push("", CAPTURE_HINT);
			return lines.map((line) => [...line].slice(0, Math.max(0, width)).join(""));
		},
		handleInput(data: string): void {
			if (is(data, "tui.select.cancel", "escape")) {
				done(undefined);
				return;
			}
			if (is(data, "tui.select.confirm", "enter")) {
				if (captured !== undefined && reason === undefined && legacy === undefined) done(captured);
				return;
			}
			let backspace = false;
			try {
				backspace = tools.matchesKey(data, "backspace");
			} catch {
				backspace = false;
			}
			if (backspace) {
				captured = undefined;
				reason = undefined;
				legacy = undefined;
				return;
			}
			capture(data);
		},
		invalidate(): void {},
	};
}
