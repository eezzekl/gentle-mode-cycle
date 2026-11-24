// One rotation: find gentle-shell's controller, read the current mode, set the next.
import { discoverHostUi, type EventBus, type ModeAdapter } from "./host-ui.ts";
import { isMode, nextMode, type Mode } from "./modes.ts";

export type CycleOutcome =
	| { kind: "changed"; from: Mode; to: Mode }
	| { kind: "unchanged"; from: Mode }
	| { kind: "unknown-mode"; mode: unknown }
	| { kind: "unavailable" };

export interface CycleOptions {
	bus: EventBus;
	/** The Pi context gentle-shell reads and sets the mode through; without it there is no adapter. */
	context: unknown;
	includeSuperYolo?: boolean;
	timeoutMs?: number;
}

export async function cycleMode(options: CycleOptions): Promise<CycleOutcome> {
	const adapter: ModeAdapter | undefined = await discoverHostUi(options.bus, options.context, options.timeoutMs);
	if (!adapter) return { kind: "unavailable" };
	try {
		if (typeof adapter.readMode !== "function" || typeof adapter.setMode !== "function") {
			return { kind: "unavailable" };
		}
		const current = await adapter.readMode();
		if (!isMode(current)) return { kind: "unknown-mode", mode: current };
		const to = nextMode(current, options.includeSuperYolo ?? false);
		const changed = await adapter.setMode(to);
		return changed ? { kind: "changed", from: current, to } : { kind: "unchanged", from: current };
	} finally {
		// Every answer registers subscriptions inside gentle-shell; release them.
		adapter.dispose?.();
	}
}
