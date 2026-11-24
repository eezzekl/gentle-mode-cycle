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
import { changedNotice, unavailableNotice, unchangedNotice, unknownModeNotice } from "../lib/notices.ts";

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
			announce(ctx, await cycleMode({ bus, context: ctx, includeSuperYolo: false }));
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
