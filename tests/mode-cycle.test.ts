import assert from "node:assert/strict";
import { test } from "node:test";

import createExtension from "../extensions/gentle-mode-cycle.ts";
import { discoverHostUi } from "../lib/host-ui.ts";

const HOST_UI_CHANNEL = "gentle:yolo:host-ui";
const DEFAULT_KEY = "alt+m";

type Notice = { message: string; type: string | undefined };
type Adapter = {
	readMode?: () => unknown;
	setMode?: (mode: string) => unknown;
	dispose?: () => void;
};

type Ctx = {
	hasUI: boolean;
	ui: {
		notify: (message: string, type?: string) => void;
		setStatus: (key: string, value: string) => void;
	};
};

type ShortcutOptions = {
	description?: string;
	handler: (ctx: Ctx) => unknown;
};
type CommandOptions = {
	description?: string;
	handler: (args: string, ctx: Ctx) => unknown;
};

type FakePi = ReturnType<typeof createFakePi>;

function createFakePi() {
	const shortcuts = new Map<string, ShortcutOptions>();
	const commands = new Map<string, CommandOptions>();
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
	return {
		shortcuts,
		commands,
		events,
		registerShortcut(key: string, options: ShortcutOptions) {
			shortcuts.set(key, options);
		},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
	};
}

function createCtx() {
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
function attachGentleShell(
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

function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function pressKey(pi: FakePi, ctx: Ctx, key = DEFAULT_KEY) {
	const shortcut = pi.shortcuts.get(key);
	assert.ok(shortcut, `shortcut ${key} must be registered`);
	await shortcut.handler(ctx);
}

async function runCommand(pi: FakePi, ctx: Ctx, args = "") {
	const command = pi.commands.get("mode-cycle");
	assert.ok(command, "command mode-cycle must be registered");
	await command.handler(args, ctx);
}

test("registers alt+m and /mode-cycle", () => {
	const pi = createFakePi();
	createExtension(pi as never);

	assert.deepEqual([...pi.shortcuts.keys()], [DEFAULT_KEY]);
	assert.notEqual(pi.shortcuts.get(DEFAULT_KEY)?.description, undefined);
	assert.deepEqual([...pi.commands.keys()], ["mode-cycle"]);
	assert.notEqual(pi.commands.get("mode-cycle")?.description, undefined);
});

test("hands gentle-shell the caller's context, which its listener requires", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { contexts } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(contexts, [ctx]);
});

test("alt+m rotates normal to auto", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "auto" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: AUTO", type: "info" }]);
});

test("alt+m rotates auto to yolo", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "auto" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "yolo" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: YOLO", type: "info" }]);
});

test("alt+m rotates yolo back to normal", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "yolo" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "normal" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
});

test("super-yolo current and excluded rotates to normal, never to a more permissive mode", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "super-yolo" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "normal" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
});

test("a second press reads the mode again and keeps rotating", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi as never);

	await pressKey(pi, ctx);
	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[
			{ method: "setMode", mode: "auto" },
			{ method: "setMode", mode: "yolo" },
		],
	);
	assert.deepEqual(notices, [
		{ message: "Permissions: AUTO", type: "info" },
		{ message: "Permissions: YOLO", type: "info" },
	]);
});

test("a refused change reports a warning instead of a success notice", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "yolo", setMode: () => false });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "normal" }],
	);
	assert.deepEqual(notices, [{ message: "Permission mode unchanged: still YOLO.", type: "warning" }]);
});

test("an unknown current mode changes nothing", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "turbo" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[],
	);
	assert.deepEqual(notices, [{ message: 'Unknown permission mode "turbo". No change made.', type: "warning" }]);
});

test("disposes the adapter on success, refusal, and unknown mode", async () => {
	for (const scenario of [
		{ name: "success", mode: "normal", setMode: undefined },
		{ name: "refusal", mode: "normal", setMode: () => false },
		{ name: "unknown mode", mode: "turbo", setMode: undefined },
	]) {
		const pi = createFakePi();
		const { ctx } = createCtx();
		const { calls } = attachGentleShell(pi, { mode: scenario.mode, setMode: scenario.setMode });
		createExtension(pi as never);

		await pressKey(pi, ctx);

		assert.equal(
			calls.filter((call) => call.method === "dispose").length,
			1,
			`dispose must run once on ${scenario.name}`,
		);
	}
});

test("disposes the adapter when setting the mode throws", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, {
		mode: "normal",
		setMode: () => {
			throw new Error("boom");
		},
	});
	createExtension(pi as never);

	await assert.rejects(() => pressKey(pi, ctx), /boom/);

	assert.equal(calls.filter((call) => call.method === "dispose").length, 1);
	assert.deepEqual(notices, []);
});

test("disposes the adapter when reading the mode throws", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal", readModeThrows: true });
	createExtension(pi as never);

	await assert.rejects(() => pressKey(pi, ctx), /read-boom/);

	assert.equal(calls.filter((call) => call.method === "dispose").length, 1);
	assert.deepEqual(notices, []);
});

test("ignores a second press while a change is in flight", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const pending = deferred();
	const { calls } = attachGentleShell(pi, { mode: "normal", setMode: () => pending.promise });
	createExtension(pi as never);

	const first = pressKey(pi, ctx);
	const second = pressKey(pi, ctx);
	pending.resolve(true);
	await Promise.all([first, second]);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "auto" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: AUTO", type: "info" }]);
});

test("warns when gentle-shell does not answer the discovery channel", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(notices, [
		{ message: "gentle-shell is not available: cannot rotate the permission mode.", type: "warning" },
	]);
});

test("warns when the answered adapter cannot read or set the mode", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal", withoutSetMode: true });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(notices, [
		{ message: "gentle-shell is not available: cannot rotate the permission mode.", type: "warning" },
	]);
	assert.equal(calls.filter((call) => call.method === "dispose").length, 1);
});

test("disposes an adapter that answers after the timeout", async () => {
	let disposed = 0;
	const adapter = {
		readMode: () => "normal",
		setMode: () => true,
		dispose: () => {
			disposed += 1;
		},
	};
	const bus = {
		emit: (_channel: string, data: unknown) => {
			setTimeout(() => {
				(data as { respond: (value: unknown) => void }).respond(adapter);
			}, 20);
		},
	};

	const found = await discoverHostUi(bus, {}, 5);
	assert.equal(found, undefined);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(disposed, 1);
});

test("/mode-cycle without arguments rotates like the key", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "auto" });
	createExtension(pi as never);

	await runCommand(pi, ctx);

	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "yolo" }],
	);
	assert.deepEqual(notices, [{ message: "Permissions: YOLO", type: "info" }]);
});

test("never writes the mode label itself", async () => {
	const pi = createFakePi();
	const { ctx, statuses } = createCtx();
	attachGentleShell(pi, { mode: "normal" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(statuses, []);
});
