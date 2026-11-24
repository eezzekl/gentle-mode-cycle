import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createGentleModeCycle } from "../extensions/gentle-mode-cycle.ts";
import { resolveAgentDir } from "../lib/config.ts";
import { discoverHostUi } from "../lib/host-ui.ts";
import { cycleMode } from "../lib/mode-cycle.ts";

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

// Never touch the real agent directory: every load gets an injected, empty temporary one.
const tempDirs: string[] = [];
function makeAgentDir(config?: unknown, raw?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-mode-cycle-test-"));
	tempDirs.push(dir);
	if (raw !== undefined) writeFileSync(join(dir, "gentle-mode-cycle.json"), raw);
	else if (config !== undefined) writeFileSync(join(dir, "gentle-mode-cycle.json"), JSON.stringify(config));
	return dir;
}
after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const sharedEmptyDir = makeAgentDir();
function createExtension(pi: unknown, agentDir: string = sharedEmptyDir) {
	return createGentleModeCycle(pi as never, { agentDir });
}

type FakePiOptions = {
	/** Names `getCommands` lists; undefined means the host has no `getCommands`. */
	commandNames?: string[];
	getCommandsThrows?: boolean;
	sendUserMessageThrows?: boolean;
};

function createFakePi(options: FakePiOptions = {}) {
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

const NOT_AVAILABLE = "gentle-shell is not available: cannot rotate the permission mode.";
const FALLBACK = "gentle-shell did not answer: opening /gentle:yolo instead.";

test("opens /gentle:yolo when gentle-shell does not answer but the command exists", async () => {
	const pi = createFakePi({ commandNames: ["mode-cycle", "gentle:yolo"] });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, [{ text: "/gentle:yolo", options: { expandPromptTemplates: true } }]);
	assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
});

test("recognises the fallback command whether it is listed with or without a leading slash", async () => {
	const pi = createFakePi({ commandNames: ["/gentle:yolo"] });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, [{ text: "/gentle:yolo", options: { expandPromptTemplates: true } }]);
	assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
});

test("the /mode-cycle command opens the same fallback", async () => {
	const pi = createFakePi({ commandNames: ["gentle:yolo"] });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await runCommand(pi, ctx);

	assert.equal(pi.sent.length, 1);
	assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
});

test("opens /gentle:yolo when the adapter lacks the methods it needs", async () => {
	const pi = createFakePi({ commandNames: ["gentle:yolo"] });
	const { ctx, notices } = createCtx();
	attachGentleShell(pi, { mode: "normal", withoutSetMode: true });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, [{ text: "/gentle:yolo", options: { expandPromptTemplates: true } }]);
	assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
});

test("only warns that gentle-shell is required when /gentle:yolo is not listed", async () => {
	const pi = createFakePi({ commandNames: ["mode-cycle", "other"] });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, []);
	assert.deepEqual(notices, [{ message: NOT_AVAILABLE, type: "warning" }]);
});

test("a getCommands that throws means no fallback, and the press does not break", async () => {
	const pi = createFakePi({ getCommandsThrows: true });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, []);
	assert.deepEqual(notices, [{ message: NOT_AVAILABLE, type: "warning" }]);
});

test("falls back to the plain warning when dispatching /gentle:yolo throws", async () => {
	const pi = createFakePi({ commandNames: ["gentle:yolo"], sendUserMessageThrows: true });
	const { ctx, notices } = createCtx();
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(notices, [{ message: NOT_AVAILABLE, type: "warning" }]);
});

test("never opens the fallback when gentle-shell answers", async () => {
	const pi = createFakePi({ commandNames: ["gentle:yolo"] });
	const { ctx } = createCtx();
	attachGentleShell(pi, { mode: "normal" });
	createExtension(pi as never);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent, []);
});

const TIMEOUT_NOTICE = "gentle-shell did not answer in time: the permission mode may not have changed.";

test("resolves Pi's agent directory from PI_CODING_AGENT_DIR, expanding a leading tilde", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir");
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/agent-dir" }), join(homedir(), "agent-dir"));
	assert.equal(resolveAgentDir({}), join(homedir(), ".pi", "agent"));
});

async function pressAndExpire(t: { mock: { timers: { tick: (ms: number) => void } } }, press: Promise<unknown>) {
	// Let the press reach its awaits, then expire the rotation budget.
	await new Promise<void>((resolve) => setImmediate(resolve));
	t.mock.timers.tick(5000);
	await press;
}

for (const hang of ["readMode", "setMode"] as const) {
	test(`${hang} that never settles warns, disposes once, and releases the lock`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = createFakePi();
		const { ctx, notices } = createCtx();
		let hung = true;
		const never = new Promise<unknown>(() => {});
		const { calls } = attachGentleShell(pi, {
			mode: "normal",
			setMode: hang === "setMode" ? () => (hung ? never : true) : undefined,
		});
		if (hang === "readMode") {
			// Wrap the responder so the first adapter's readMode hangs.
			const original = pi.events.emit.bind(pi.events);
			pi.events.emit = (channel: string, data: unknown) => {
				if (channel === HOST_UI_CHANNEL && hung) {
					const request = data as { respond: (adapter: unknown) => void };
					const respond = request.respond;
					request.respond = (adapter) => {
						(adapter as Adapter).readMode = () => {
							calls.push({ method: "readMode" });
							return never;
						};
						respond(adapter);
					};
				}
				original(channel, data);
			};
		}
		createExtension(pi as never);

		await pressAndExpire(t, pressKey(pi, ctx));

		assert.deepEqual(notices, [{ message: TIMEOUT_NOTICE, type: "warning" }]);
		assert.equal(calls.filter((call) => call.method === "dispose").length, 1);

		// A later press starts a fresh rotation: the lock was released.
		hung = false;
		await pressKey(pi, ctx);
		assert.deepEqual(notices.slice(1), [{ message: "Permissions: AUTO", type: "info" }]);
		assert.equal(calls.filter((call) => call.method === "dispose").length, 2);
	});
}

test("/mode-cycle warns on timeout too, and a late setMode result is ignored", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const late = deferred();
	const { calls } = attachGentleShell(pi, { mode: "normal", setMode: () => late.promise });
	createExtension(pi as never);

	await pressAndExpire(t, runCommand(pi, ctx));
	late.resolve(true);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(notices, [{ message: TIMEOUT_NOTICE, type: "warning" }]);
	assert.equal(calls.filter((call) => call.method === "dispose").length, 1);
});
test("never calls setMode after the rotation budget expired", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const late = deferred();
	const calls: string[] = [];
	pi.events.on(HOST_UI_CHANNEL, (data) => {
		const request = data as { context?: unknown; respond?: (adapter: unknown) => void };
		if (typeof request?.respond !== "function" || !request.context) return;
		request.respond({
			readMode: () => late.promise,
			setMode: (mode: string) => {
				calls.push(mode);
				return true;
			},
			dispose: () => {
				calls.push("dispose");
			},
		});
	});
	createExtension(pi as never);

	await pressAndExpire(t, pressKey(pi, ctx));
	late.resolve("normal");
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(notices, [{ message: TIMEOUT_NOTICE, type: "warning" }]);
	assert.deepEqual(calls, ["dispose"]);
});

test("releases an adapter that answers only after the rotation budget expired", async () => {
	let disposed = 0;
	const bus = {
		emit: (_channel: string, data: unknown) => {
			setTimeout(() => {
				(data as { respond: (value: unknown) => void }).respond({
					readMode: () => "normal",
					setMode: () => true,
					dispose: () => {
						disposed += 1;
					},
				});
			}, 20);
		},
	};

	const outcome = await cycleMode({ bus, context: {}, rotationTimeoutMs: 1 });
	await new Promise<void>((resolve) => setTimeout(resolve, 40));

	assert.deepEqual(outcome, { kind: "timeout" });
	assert.equal(disposed, 1);
});

// ---- T3: configurable key ----

const CONFIG_FILE = "gentle-mode-cycle.json";
const readConfigFile = (dir: string) => JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"));

test("with no config file the key is alt+m", () => {
	const pi = createFakePi();
	createExtension(pi, makeAgentDir());

	assert.deepEqual([...pi.shortcuts.keys()], ["alt+m"]);
});

test("a valid custom key from the file is registered at load", () => {
	const pi = createFakePi();
	createExtension(pi, makeAgentDir({ key: "ctrl+shift+k" }));

	assert.deepEqual([...pi.shortcuts.keys()], ["ctrl+shift+k"]);
});

for (const value of ["off", ""]) {
	test(`key ${JSON.stringify(value)} registers no shortcut and /mode-cycle still rotates`, async () => {
		const pi = createFakePi();
		const { ctx, notices } = createCtx();
		const { calls } = attachGentleShell(pi, { mode: "normal" });
		createExtension(pi, makeAgentDir({ key: value }));

		assert.deepEqual([...pi.shortcuts.keys()], []);
		await runCommand(pi, ctx);

		assert.deepEqual(
			calls.filter((call) => call.method === "setMode"),
			[{ method: "setMode", mode: "auto" }],
		);
		assert.deepEqual(notices, [{ message: "Permissions: AUTO", type: "info" }]);
	});
}

for (const bad of ["ctrl+m", "m", "banana+m", "ctrl+", 42]) {
	test(`an invalid file value ${JSON.stringify(bad)} falls back to alt+m and warns on session start`, async () => {
		const pi = createFakePi();
		const { ctx, notices } = createCtx();
		createExtension(pi, makeAgentDir({ key: bad }));

		assert.deepEqual([...pi.shortcuts.keys()], ["alt+m"]);
		assert.equal(notices.length, 0);
		await pi.emitLifecycle("session_start", ctx);

		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.type, "warning");
		assert.match(notices[0]?.message ?? "", /alt\+m/);
		// Warned once: a second session start in the same load does not repeat it.
		await pi.emitLifecycle("session_start", ctx);
		assert.equal(notices.length, 1);
	});
}

test("a valid or missing file does not warn on session start", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	createExtension(pi, makeAgentDir({ key: "alt+n" }));
	await pi.emitLifecycle("session_start", ctx);

	assert.deepEqual(notices, []);
});

test("a malformed file means defaults and never crashes a press", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, makeAgentDir(undefined, "{ not json"));

	assert.deepEqual([...pi.shortcuts.keys()], ["alt+m"]);
	await pi.emitLifecycle("session_start", ctx);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "warning");
	await pressKey(pi, ctx);
	assert.deepEqual(
		calls.filter((call) => call.method === "setMode"),
		[{ method: "setMode", mode: "auto" }],
	);
});

test("/mode-cycle key alt+n writes the file and asks for /reload and mentions /hotkeys", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, dir);

	await runCommand(pi, ctx, "key alt+n");

	assert.deepEqual(readConfigFile(dir), { key: "alt+n" });
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "info");
	assert.match(notices[0]?.message ?? "", /alt\+n/);
	assert.match(notices[0]?.message ?? "", /\/reload/);
	assert.match(notices[0]?.message ?? "", /\/hotkeys/);
	assert.deepEqual(calls, [], "saving a key never rotates");
});

for (const bad of ["ctrl+m", "m", "ctrl+i", "ctrl+j", "alt+", "alt+shift", "foo+m", "alt+alt+m", ""]) {
	test(`/mode-cycle key ${JSON.stringify(bad)} is rejected and the file is left unchanged`, async () => {
		const dir = makeAgentDir({ key: "alt+x" });
		const before = readFileSync(join(dir, CONFIG_FILE), "utf8");
		const pi = createFakePi();
		const { ctx, notices } = createCtx();
		createExtension(pi, dir);

		await runCommand(pi, ctx, `key ${bad}`);

		assert.equal(readFileSync(join(dir, CONFIG_FILE), "utf8"), before);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.type, "warning");
	});
}

test("a rejected key does not create the file", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	const { ctx } = createCtx();
	createExtension(pi, dir);

	await runCommand(pi, ctx, "key ctrl+m");

	assert.equal(existsSync(join(dir, CONFIG_FILE)), false);
});

test("accepts modifier combinations: alt+m, ctrl+shift+k, super+k", async () => {
	for (const key of ["alt+m", "ctrl+shift+k", "super+k", "Ctrl+K"]) {
		const dir = makeAgentDir();
		const pi = createFakePi();
		const { ctx } = createCtx();
		createExtension(pi, dir);
		await runCommand(pi, ctx, `key ${key}`);
		assert.equal(readConfigFile(dir).key, key.toLowerCase());
	}
});

test("/mode-cycle key off saves off, and the command keeps rotating", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	createExtension(pi, dir);

	await runCommand(pi, ctx, "key off");

	assert.deepEqual(readConfigFile(dir), { key: "off" });
	assert.match(notices[0]?.message ?? "", /\/reload/);
});

test("writing the key preserves unknown fields already in the file", async () => {
	const dir = makeAgentDir({ key: "alt+x", includeSuperYolo: true, custom: { a: 1 } });
	const pi = createFakePi();
	const { ctx } = createCtx();
	createExtension(pi, dir);

	await runCommand(pi, ctx, "key alt+n");

	assert.deepEqual(readConfigFile(dir), { key: "alt+n", includeSuperYolo: true, custom: { a: 1 } });
});

test("/mode-cycle status shows the key, super-yolo and the config path", async () => {
	const dir = makeAgentDir({ key: "alt+n", includeSuperYolo: true });
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, dir);

	await runCommand(pi, ctx, "status");

	assert.equal(notices.length, 1);
	const message = notices[0]?.message ?? "";
	assert.match(message, /alt\+n/);
	assert.match(message, /super-yolo: included/);
	assert.ok(message.includes(join(dir, CONFIG_FILE)));
	assert.deepEqual(calls, [], "status never rotates");
});

test("/mode-cycle status defaults: alt+m and super-yolo not included; shows off when disabled", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	createExtension(pi, makeAgentDir());
	await runCommand(pi, ctx, "status");
	assert.match(notices[0]?.message ?? "", /alt\+m/);
	assert.match(notices[0]?.message ?? "", /super-yolo: not included/);

	const pi2 = createFakePi();
	const second = createCtx();
	createExtension(pi2, makeAgentDir({ key: "off" }));
	await runCommand(pi2, second.ctx, "status");
	assert.match(second.notices[0]?.message ?? "", /off/);
});

test("an unknown subcommand prints usage and does not rotate", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, makeAgentDir());

	await runCommand(pi, ctx, "frobnicate");

	assert.deepEqual(calls, []);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /Usage/);
	assert.match(notices[0]?.message ?? "", /status/);
});
