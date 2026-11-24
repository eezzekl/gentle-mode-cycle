// Discovery of gentle-shell's mode controller. gentle-shell cannot be imported
// (its package.json exports nothing), so this talks to it over Pi's event bus:
// emit on its host-UI channel and let its responder hand back an adapter.

/** gentle-shell's private channel constant, copied by name. */
export const HOST_UI_CHANNEL = "gentle:yolo:host-ui";

/** gentle-shell's own wait before it gives up on the host UI. */
export const DISCOVERY_TIMEOUT_MS = 100;

/** The part of gentle-shell's adapter this extension uses. */
export interface ModeAdapter {
	readMode?: () => unknown;
	setMode?: (mode: string) => unknown;
	dispose?: () => void;
}

export interface EventBus {
	emit: (channel: string, data: unknown) => void;
}

/** What gentle-shell's listener expects on the channel. */
export interface DiscoveryRequest {
	/** Its listener ignores a request without this, so a missing context means no adapter. */
	context: unknown;
	respond: (adapter: unknown) => void;
}

/**
 * Ask gentle-shell for its adapter, with a timeout. No answer, or an answer that
 * is not an object, means gentle-shell is not there to change the mode.
 */
export function discoverHostUi(
	bus: EventBus,
	context: unknown,
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<ModeAdapter | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const accept = (value: unknown): void => {
			const adapter = value && typeof value === "object" ? (value as ModeAdapter) : undefined;
			if (settled) {
				// An answer after the timeout, or a second one, still registers
				// subscriptions inside gentle-shell: release it and keep the first result.
				adapter?.dispose?.();
				return;
			}
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(adapter);
		};
		timer = setTimeout(() => accept(undefined), timeoutMs);
		try {
			const request: DiscoveryRequest = { context, respond: (value: unknown) => accept(value) };
			bus.emit(HOST_UI_CHANNEL, request);
		} catch {
			accept(undefined);
		}
	});
}
