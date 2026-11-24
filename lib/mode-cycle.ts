// One rotation: find gentle-shell's controller, read the current mode, set the next.
import { discoverHostUi, type EventBus, type ModeAdapter } from "./host-ui.ts";
import { isMode, nextMode, type Mode } from "./modes.ts";

export type CycleOutcome =
	| { kind: "changed"; from: Mode; to: Mode }
	| { kind: "unchanged"; from: Mode }
	| { kind: "unknown-mode"; mode: unknown }
	| { kind: "unavailable" }
	| { kind: "timeout"; from?: Mode };

export interface CycleOptions {
	bus: EventBus;
	/** The Pi context gentle-shell reads and sets the mode through; without it there is no adapter. */
	context: unknown;
	includeSuperYolo?: boolean;
	/** Discovery wait; defaults to gentle-shell's own 100 ms. */
	timeoutMs?: number;
	/** Budget for discovery plus readMode plus setMode; tests override it. */
	rotationTimeoutMs?: number;
}

/** The whole rotation gives up after this long, so a hung gentle-shell cannot mute the key. */
export const ROTATION_TIMEOUT_MS = 5000;

export async function cycleMode(options: CycleOptions): Promise<CycleOutcome> {
	let adapter: ModeAdapter | undefined;
	let from: Mode | undefined;
	let expired = false;
	let disposed = false;
	// Every answer registers subscriptions inside gentle-shell; release them, once.
	const release = (): void => {
		if (disposed || !adapter) return;
		disposed = true;
		adapter.dispose?.();
	};

	const work = (async (): Promise<CycleOutcome> => {
		const found = await discoverHostUi(options.bus, options.context, options.timeoutMs);
		if (!found) return { kind: "unavailable" };
		adapter = found;
		try {
			if (expired) return { kind: "timeout" };
			if (typeof found.readMode !== "function" || typeof found.setMode !== "function") {
				return { kind: "unavailable" };
			}
			const current = await found.readMode();
			// The budget can expire while the mode is being read: never touch a released adapter further.
			if (expired) return { kind: "timeout" };
			if (!isMode(current)) return { kind: "unknown-mode", mode: current };
			from = current;
			const to = nextMode(current, options.includeSuperYolo ?? false);
			const changed = await found.setMode(to);
			return changed ? { kind: "changed", from: current, to } : { kind: "unchanged", from: current };
		} finally {
			release();
		}
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<CycleOutcome>((resolve) => {
		timer = setTimeout(() => {
			expired = true;
			// A late result of `work` is ignored: the adapter is released now.
			release();
			resolve(from === undefined ? { kind: "timeout" } : { kind: "timeout", from });
		}, options.rotationTimeoutMs ?? ROTATION_TIMEOUT_MS);
	});
	// If the timeout wins, a later failure of `work` must not become an unhandled rejection.
	work.catch(() => {});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
