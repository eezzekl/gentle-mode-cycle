import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createGentleModeCycle } from "../extensions/gentle-mode-cycle.ts";
import { resolveAgentDir } from "../lib/config.ts";
import { discoverHostUi } from "../lib/host-ui.ts";
import { cycleMode } from "../lib/mode-cycle.ts";
import * as notices_ from "../lib/notices.ts";
import {
	attachGentleShell,
	createCtx,
	createExtension,
	createFakePi,
	deferred,
	disposeTempDirs,
	makeAgentDir,
	pressAndExpire,
	pressKey,
	runCommand,
	setModes,
	sharedEmptyDir,
	CONFIG_FILE,
	readConfigFile,
	TIMEOUT_NOTICE,
	NOT_AVAILABLE,
	FALLBACK,
	DEFAULT_KEY,
	HOST_UI_CHANNEL,
	type Adapter,
	type CommandOptions,
	type Ctx,
	type FakePi,
	type FakePiOptions,
	type Notice,
	type ShortcutOptions,
} from "./support/mode-cycle-harness.ts";

after(disposeTempDirs);

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
