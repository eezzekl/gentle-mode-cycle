// Shared harness for the gentle-mode-cycle tests: a fake Pi, a fake gentle-shell that
// keeps the real listener guard, an injected temporary agent directory, and helpers to
// press the key or run the command. Importing a test file owns its own temporary
// directories; call disposeTempDirs() from an `after` hook.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGentleModeCycle } from "../../extensions/gentle-mode-cycle.ts";

export const HOST_UI_CHANNEL = "gentle:yolo:host-ui";
export const DEFAULT_KEY = "alt+m";

export type Notice = { message: string; type: string | undefined };
export type Adapter = {
	readMode?: () => unknown;
	setMode?: (mode: string) => unknown;
	dispose?: () => void;
};

export type Ctx = {
	hasUI: boolean;
	mode?: string;
	ui: {
		notify: (message: string, type?: string) => void;
		setStatus: (key: string, value: string) => void;
		custom?: (factory: (...args: unknown[]) => unknown, options?: unknown) => Promise<unknown>;
	};
};

export type ShortcutOptions = {
	description?: string;
	handler: (ctx: Ctx) => unknown;
};
export type CommandOptions = {
	description?: string;
	handler: (args: string, ctx: Ctx) => unknown;
};

export type FakePi = ReturnType<typeof createFakePi>;

// Never touch the real agent directory: every load gets an injected, empty temporary one.
export const tempDirs: string[] = [];
export function makeAgentDir(config?: unknown, raw?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-mode-cycle-test-"));
	tempDirs.push(dir);
	if (raw !== undefined) writeFileSync(join(dir, "gentle-mode-cycle.json"), raw);
	else if (config !== undefined) writeFileSync(join(dir, "gentle-mode-cycle.json"), JSON.stringify(config));
	return dir;
}
/** Remove every temporary agent directory this test file created. */
export function disposeTempDirs(): void {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
export const sharedEmptyDir = makeAgentDir();
export function createExtension(pi: unknown, agentDir: string = sharedEmptyDir) {
	return createGentleModeCycle(pi as never, { agentDir });
}

export type FakePiOptions = {
	/** Names `getCommands` lists; undefined means the host has no `getCommands`. */
	commandNames?: string[];
	getCommandsThrows?: boolean;
	sendUserMessageThrows?: boolean;
};

export function createFakePi(options: FakePiOptions = {}) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const shortcuts = new Map<string, ShortcutOptions>();
	const commands = new Map<string, CommandOptions>();
	const lifecycle = new Map<string, Array<(event: unknown, ctx: Ctx) => unknown>>();
	const channelHandlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const handlers = channelHandlers.get(channel) ?? new Set();
			handlers.add(handler);
			channelHandlers.set(channel, handlers);
			return () => {
				handlers.delete(handler);
			};
		},
		emit(channel: string, data: unknown) {
			for (const handler of [...(channelHandlers.get(channel) ?? [])]) handler(data);
		},
	};
	const host: Record<string, unknown> = {};
	if (options.commandNames !== undefined || options.getCommandsThrows) {
		host.getCommands = () => {
			if (options.getCommandsThrows) throw new Error("commands-boom");
			return (options.commandNames ?? []).map((name) => ({ name, source: "extension" }));
		};
	}
	return {
		...host,
		sent,
		sendUserMessage(text: string, sendOptions?: unknown) {
			if (options.sendUserMessageThrows) throw new Error("send-boom");
			sent.push({ text, options: sendOptions });
		},
		shortcuts,
		commands,
		events,
		on(event: string, handler: (event: unknown, ctx: Ctx) => unknown) {
			lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
		},
		async emitLifecycle(event: string, ctx: Ctx) {
			for (const handler of lifecycle.get(event) ?? []) await handler({ type: event }, ctx);
		},
		registerShortcut(key: string, options: ShortcutOptions) {
			shortcuts.set(key, options);
		},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
	};
}

export function createCtx() {
	const notices: Notice[] = [];
	const statuses: Array<{ key: string; value: string }> = [];
	const ctx: Ctx = {
		hasUI: true,
		ui: {
			notify: (message, type) => {
				notices.push({ message, type });
			},
			setStatus: (key, value) => {
				statuses.push({ key, value });
			},
		},
	};
	return { ctx, notices, statuses };
}

/**
 * A stand-in for gentle-shell. Its listener keeps the real guard
 * (gentle-shell/lib/yolo-session-policy.ts:326): without a context, it stays
 * silent. A successful setMode moves the mode the next read returns, the way
 * gentle-shell's own setMode does.
 */
export function attachGentleShell(
	pi: FakePi,
	options: {
		mode?: unknown;
		setMode?: (mode: string) => unknown;
		withoutSetMode?: boolean;
		withoutReadMode?: boolean;
		readModeThrows?: boolean;
		dispose?: () => void;
	},
) {
	const calls: Array<{ method: string; mode?: string }> = [];
	const contexts: unknown[] = [];
	let current = options.mode;
	pi.events.on(HOST_UI_CHANNEL, (data) => {
		const request = data as { context?: unknown; respond?: (adapter: unknown) => void };
		if (typeof request?.respond !== "function" || !request.context) return;
		contexts.push(request.context);
		const adapter: Adapter = {
			dispose: () => {
				calls.push({ method: "dispose" });
				options.dispose?.();
			},
		};
		if (!options.withoutReadMode) {
			adapter.readMode = () => {
				calls.push({ method: "readMode" });
				if (options.readModeThrows) throw new Error("read-boom");
				return current;
			};
		}
		if (!options.withoutSetMode) {
			adapter.setMode = (mode: string) => {
				calls.push({ method: "setMode", mode });
				const result = options.setMode ? options.setMode(mode) : true;
				if (result === true) current = mode;
				return result;
			};
		}
		request.respond(adapter);
	});
	return { calls, contexts };
}

export function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export async function pressKey(pi: FakePi, ctx: Ctx, key = DEFAULT_KEY) {
	const shortcut = pi.shortcuts.get(key);
	assert.ok(shortcut, `shortcut ${key} must be registered`);
	await shortcut.handler(ctx);
}

export async function runCommand(pi: FakePi, ctx: Ctx, args = "") {
	const command = pi.commands.get("mode-cycle");
	assert.ok(command, "command mode-cycle must be registered");
	await command.handler(args, ctx);
}


export async function pressAndExpire(t: { mock: { timers: { tick: (ms: number) => void } } }, press: Promise<unknown>) {
	// Let the press reach its awaits, then expire the rotation budget.
	await new Promise<void>((resolve) => setImmediate(resolve));
	t.mock.timers.tick(5000);
	await press;
}

export const TIMEOUT_NOTICE = "gentle-shell did not answer in time: the permission mode may not have changed.";

export const CONFIG_FILE = "gentle-mode-cycle.json";

/** The parsed config file of a temporary agent directory. */
export const readConfigFile = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"));

/** The S8 notice when gentle-shell does not answer and no fallback command exists. */
export const NOT_AVAILABLE = "gentle-shell is not available: cannot rotate the permission mode.";

/** The S8 notice when gentle-shell did not answer and /gentle:yolo is opened instead. */
export const FALLBACK = "gentle-shell did not answer: opening /gentle:yolo instead.";

/** The modes a fake gentle-shell was asked to set, in order. */
export const setModes = (calls: Array<{ method: string; mode?: string }>) =>
	calls.filter((call) => call.method === "setMode").map((call) => call.mode);
