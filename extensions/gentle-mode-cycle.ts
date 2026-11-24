/**
 * gentle-mode-cycle: one key (or /mode-cycle) moves the session permission mode
 * to the next one, so the user never walks through /gentle:customize.
 *
 * The change itself is applied by gentle-shell's own setMode, which keeps its
 * interactivity and identity checks; this extension relaxes nothing and never
 * writes the mode label: gentle-shell publishes it when the mode changes.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { configPath, DEFAULT_KEY, resolveAgentDir, resolveConfig, validateKey, writeConfig } from "../lib/config.ts";
import { createKeyCapture, loadKeyTools as defaultLoadKeyTools, type KeyTools } from "../lib/key-capture.ts";
import { cycleMode, type CycleOutcome } from "../lib/mode-cycle.ts";
import {
	changedNotice,
	fallbackNotice,
	invalidKeyNotice,
	keyRejectedNotice,
	keySavedNotice,
	malformedConfigNotice,
	saveFailedNotice,
	statusNotice,
	timeoutNotice,
	unavailableNotice,
	unchangedNotice,
	unknownModeNotice,
	usageNotice,
} from "../lib/notices.ts";

export { DEFAULT_KEY };
export const COMMAND_NAME = "mode-cycle";

export interface LoadOptions {
	/** Pi's agent directory; injected by tests so they never touch the real one. */
	agentDir: string;
	/** Loads pi-tui's key helpers when the capture box opens; injected by tests. */
	loadKeyTools?: () => Promise<KeyTools | undefined>;
}

/** Pi's entry point: resolve where the config lives, then wire the extension. */
export default function gentleModeCycle(pi: ExtensionAPI): void {
	createGentleModeCycle(pi, { agentDir: resolveAgentDir() });
}

export function createGentleModeCycle(pi: ExtensionAPI, { agentDir, loadKeyTools = defaultLoadKeyTools }: LoadOptions): void {
	// The key is fixed at load: Pi registers shortcuts only then.
	const loaded = resolveConfig(agentDir);
	const file = configPath(agentDir);
	// Two presses must never compute the next mode from a stale read.
	let inFlight = false;

	const bus = {
		emit: (channel: string, data: unknown) => {
			pi.events.emit(channel, data);
		},
	};

	const rotate = async (ctx: ExtensionContext): Promise<void> => {
		if (inFlight) return;
		inFlight = true;
		try {
			const outcome = await cycleMode({ bus, context: ctx, includeSuperYolo: false });
			if (outcome.kind === "unavailable" && ctx.hasUI && openFallback(pi)) {
				ctx.ui.notify(fallbackNotice(), "warning");
				return;
			}
			announce(ctx, outcome);
		} finally {
			inFlight = false;
		}
	};

	if (loaded.shortcut !== null) {
		pi.registerShortcut(loaded.shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Rotate the session permission mode (normal → auto → yolo)",
			handler: async (ctx) => {
				await rotate(ctx);
			},
		});
	}

	// No context exists at load time, so a bad file is reported when the session starts.
	let warned = false;
	pi.on("session_start", (_event, ctx) => {
		if (warned) return;
		warned = true;
		if (loaded.invalid) say(ctx, invalidKeyNotice(loaded.invalid.value, loaded.invalid.reason, file), "warning");
		else if (loaded.malformed) say(ctx, malformedConfigNotice(file), "warning");
	});

	/**
	 * `/mode-cycle key` alone: a box that captures the pressed combination. Resolves to
	 * the captured key, or undefined when cancelled; null when no capture is possible
	 * here (no TUI, pi-tui missing or failing), so the typed usage is shown instead.
	 */
	const captureKey = async (ctx: ExtensionContext): Promise<string | undefined | null> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return null;
		try {
			const tools = await loadKeyTools();
			if (!tools) return null;
			// undefined (RPC mode, or Escape) is a cancel.
			const value = await ctx.ui.custom<string | undefined>((_tui, _theme, keybindings, done) =>
				createKeyCapture(tools, keybindings as never, done),
			);
			return typeof value === "string" ? value : undefined;
		} catch {
			return null;
		}
	};

	const saveKey = (ctx: ExtensionContext, args: string[]): void => {
		const [value] = args;
		if (value === undefined || args.length > 1) {
			say(ctx, keyRejectedNotice(args.join(" "), "give exactly one key, or off"), "warning");
			return;
		}
		const check = validateKey(value);
		if (!check.ok) {
			say(ctx, keyRejectedNotice(value, check.reason), "warning");
			return;
		}
		try {
			writeConfig(agentDir, { key: check.key ?? "off" });
		} catch (error) {
			say(ctx, saveFailedNotice(file, error), "warning");
			return;
		}
		say(ctx, keySavedNotice(check.key), "info");
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Rotate the session permission mode (no arguments); `key` captures a new key (or `key <key|off>` sets it), `status` shows the settings",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter((word) => word !== "");
			const [subcommand, ...rest] = words;
			if (subcommand === undefined) {
				await rotate(ctx);
			} else if (subcommand === "key") {
				if (rest.length === 0) {
					const captured = await captureKey(ctx);
					if (captured === undefined) return;
					if (captured !== null) {
						saveKey(ctx, [captured]);
						return;
					}
				}
				saveKey(ctx, rest);
			} else if (subcommand === "status" && rest.length === 0) {
				const now = resolveConfig(agentDir);
				say(
					ctx,
					statusNotice({
						shortcut: loaded.shortcut,
						...(now.shortcut === loaded.shortcut ? {} : { pending: now.shortcut }),
						includeSuperYolo: now.includeSuperYolo,
						configFile: file,
					}),
					"info",
				);
			} else {
				say(ctx, usageNotice(), "warning");
			}
		},
	});
}

function say(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

const FALLBACK_COMMAND = "gentle:yolo";

/**
 * gentle-shell did not answer the channel. If its /gentle:yolo command is listed,
 * gentle-shell is present with a changed internal contract: open that command.
 * Any failure here means no fallback; it must never break the press.
 */
function openFallback(pi: ExtensionAPI): boolean {
	try {
		// Pi lists command names without the leading slash; accept either form,
		// because a name mismatch would silently disable the fallback.
		const listed = (pi.getCommands?.() ?? []).some(
			(command) => command.name.replace(/^\//, "") === FALLBACK_COMMAND,
		);
		if (!listed) return false;
		pi.sendUserMessage(`/${FALLBACK_COMMAND}`, { expandPromptTemplates: true });
		return true;
	} catch {
		return false;
	}
}

function announce(ctx: ExtensionContext, outcome: CycleOutcome): void {
	if (!ctx.hasUI) return;
	switch (outcome.kind) {
		case "changed":
			ctx.ui.notify(changedNotice(outcome.to), "info");
			return;
		case "unchanged":
			ctx.ui.notify(unchangedNotice(outcome.from), "warning");
			return;
		case "unknown-mode":
			ctx.ui.notify(unknownModeNotice(outcome.mode), "warning");
			return;
		case "unavailable":
			ctx.ui.notify(unavailableNotice(), "warning");
			return;
		case "timeout":
			ctx.ui.notify(timeoutNotice(), "warning");
			return;
	}
}
