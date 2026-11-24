/**
 * gentle-mode-cycle: one key (or /mode-cycle) moves the session permission mode
 * to the next one, so the user never walks through /gentle:customize.
 *
 * The change itself is applied by gentle-shell's own setMode, which keeps its
 * interactivity and identity checks; this extension relaxes nothing and never
 * writes the mode label: gentle-shell publishes it when the mode changes.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { cycleMode, type CycleOutcome } from "../lib/mode-cycle.ts";
import { changedNotice, fallbackNotice, unavailableNotice, unchangedNotice, unknownModeNotice } from "../lib/notices.ts";

/** The default key. Configurable from a later task; ctrl+m is Enter in terminals. */
export const DEFAULT_KEY = "alt+m";
export const COMMAND_NAME = "mode-cycle";

export default function gentleModeCycle(pi: ExtensionAPI): void {
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

	pi.registerShortcut(DEFAULT_KEY as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Rotate the session permission mode (normal → auto → yolo)",
		handler: async (ctx) => {
			await rotate(ctx);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Rotate the session permission mode; with no arguments it does what the key does",
		handler: async (_args, ctx) => {
			await rotate(ctx);
		},
	});
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
	}
}
