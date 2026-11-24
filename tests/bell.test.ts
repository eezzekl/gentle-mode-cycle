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

// ---- T5: feedback — success notice switch and the bell on entering normal -----

const BELL = "\x07";

function createBellCtx(mode: string | null = "tui") {
	const made = createCtx();
	if (mode !== null) made.ctx.mode = mode;
	return made;
}

function loadWithBell(pi: FakePi, config?: unknown, writeBell?: (data: string) => void, raw?: string) {
	const writes: string[] = [];
	createGentleModeCycle(pi as never, {
		agentDir: makeAgentDir(config, raw),
		writeBell: writeBell ?? ((data: string) => void writes.push(data)),
	});
	return writes;
}

test("a change into normal rings the bell exactly once, after the notice", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo" });
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(writes, [BELL]);
	assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
});

test("the /mode-cycle command rings on entering normal too", async () => {
	const pi = createFakePi();
	const { ctx } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo" });
	const writes = loadWithBell(pi);

	await runCommand(pi, ctx);

	assert.deepEqual(writes, [BELL]);
});

test("changes into auto, yolo and super-yolo never ring", async () => {
	const pi = createFakePi();
	const { ctx } = createBellCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	const writes = loadWithBell(pi, { includeSuperYolo: true });

	await pressKey(pi, ctx); // auto
	await pressKey(pi, ctx); // yolo
	await pressKey(pi, ctx); // super-yolo
	assert.deepEqual(setModes(calls), ["auto", "yolo", "super-yolo"]);
	assert.deepEqual(writes, []);

	await pressKey(pi, ctx); // normal
	assert.deepEqual(writes, [BELL]);
});

test("bellOnNormal false never rings but the notice stays", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo" });
	const writes = loadWithBell(pi, { bellOnNormal: false });

	await pressKey(pi, ctx);

	assert.deepEqual(writes, []);
	assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
});

test("bellOnNormal is read on every press", async () => {
	const pi = createFakePi();
	const { ctx } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo" });
	const dir = makeAgentDir({ bellOnNormal: false });
	const writes: string[] = [];
	createGentleModeCycle(pi as never, { agentDir: dir, writeBell: (data) => void writes.push(data) });

	await pressKey(pi, ctx); // → normal, muted
	writeFileSync(join(dir, "gentle-mode-cycle.json"), JSON.stringify({ bellOnNormal: true }));
	await pressKey(pi, ctx); // → auto
	await pressKey(pi, ctx); // → yolo
	await pressKey(pi, ctx); // → normal, rings

	assert.deepEqual(writes, [BELL]);
});

test("a refused change never rings", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo", setMode: () => false });
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(writes, []);
	assert.deepEqual(notices, [{ message: "Permission mode unchanged: still YOLO.", type: "warning" }]);
});

test("an unknown mode never rings", async () => {
	const pi = createFakePi();
	const { ctx } = createBellCtx();
	attachGentleShell(pi, { mode: "turbo" });
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(writes, []);
});

test("a timeout never rings", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	attachGentleShell(pi, { mode: "yolo", setMode: () => new Promise<unknown>(() => {}) });
	const writes = loadWithBell(pi);

	await pressAndExpire(t, pressKey(pi, ctx));

	assert.deepEqual(writes, []);
	assert.deepEqual(notices, [{ message: TIMEOUT_NOTICE, type: "warning" }]);
});

test("gentle-shell unavailable never rings", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(writes, []);
	assert.deepEqual(notices, [{ message: NOT_AVAILABLE, type: "warning" }]);
});

test("the /gentle:yolo fallback never rings", async () => {
	const pi = createFakePi({ commandNames: ["gentle:yolo"] });
	const { ctx, notices } = createBellCtx();
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(pi.sent.length, 1);
	assert.deepEqual(writes, []);
	assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
});

for (const mode of ["print", "json", "rpc", null] as const) {
	test(`ctx.mode ${String(mode ?? "unset")} never rings, the notice still shows`, async () => {
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx(mode);
		attachGentleShell(pi, { mode: "yolo" });
		const writes = loadWithBell(pi);

		await pressKey(pi, ctx);

		assert.deepEqual(writes, []);
		assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
	});
}

test("notify false hides the success notice but the change and the bell happen", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	const { calls } = attachGentleShell(pi, { mode: "yolo" });
	const writes = loadWithBell(pi, { notify: false });

	await pressKey(pi, ctx);

	assert.deepEqual(setModes(calls), ["normal"]);
	assert.deepEqual(notices, []);
	assert.deepEqual(writes, [BELL]);
});

test("notify false is read on every press", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	attachGentleShell(pi, { mode: "normal" });
	const dir = makeAgentDir({ notify: false });
	createGentleModeCycle(pi as never, { agentDir: dir, writeBell: () => {} });

	await pressKey(pi, ctx);
	assert.deepEqual(notices, []);
	writeFileSync(join(dir, "gentle-mode-cycle.json"), JSON.stringify({ notify: true }));
	await pressKey(pi, ctx);

	assert.deepEqual(notices, [{ message: "Permissions: YOLO", type: "info" }]);
});

test("notify false keeps every warning", async (t) => {
	// refused
	{
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		attachGentleShell(pi, { mode: "yolo", setMode: () => false });
		loadWithBell(pi, { notify: false });
		await pressKey(pi, ctx);
		assert.deepEqual(notices, [{ message: "Permission mode unchanged: still YOLO.", type: "warning" }]);
	}
	// unknown mode
	{
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		attachGentleShell(pi, { mode: "turbo" });
		loadWithBell(pi, { notify: false });
		await pressKey(pi, ctx);
		assert.deepEqual(notices, [{ message: notices_.unknownModeNotice("turbo"), type: "warning" }]);
	}
	// unavailable
	{
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		loadWithBell(pi, { notify: false });
		await pressKey(pi, ctx);
		assert.deepEqual(notices, [{ message: NOT_AVAILABLE, type: "warning" }]);
	}
	// fallback
	{
		const pi = createFakePi({ commandNames: ["gentle:yolo"] });
		const { ctx, notices } = createBellCtx();
		loadWithBell(pi, { notify: false });
		await pressKey(pi, ctx);
		assert.deepEqual(notices, [{ message: FALLBACK, type: "warning" }]);
	}
});

test("notify false keeps the timeout warning", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	{
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		attachGentleShell(pi, { mode: "yolo", setMode: () => new Promise<unknown>(() => {}) });
		loadWithBell(pi, { notify: false });
		await pressAndExpire(t, pressKey(pi, ctx));
		assert.deepEqual(notices, [{ message: TIMEOUT_NOTICE, type: "warning" }]);
	}
});

test("notify false keeps the key, config and save warnings", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	const dir = makeAgentDir({ notify: false, key: "ctrl+m" });
	createGentleModeCycle(pi as never, { agentDir: dir, writeBell: () => {} });

	await pi.emitLifecycle("session_start", ctx);
	await runCommand(pi, ctx, "key bogus");

	assert.equal(notices.length, 2);
	assert.deepEqual(notices.map((notice) => notice.type), ["warning", "warning"]);
});

for (const bad of ["false", "no", 0, 1, null, [], {}]) {
	test(`non-boolean notify/bellOnNormal ${JSON.stringify(bad)} mean the defaults (both on)`, async () => {
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		attachGentleShell(pi, { mode: "yolo" });
		const writes = loadWithBell(pi, { notify: bad, bellOnNormal: bad });

		await pressKey(pi, ctx);

		assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
		assert.deepEqual(writes, [BELL]);
	});
}

test("a malformed or missing file keeps notice and bell on", async () => {
	for (const raw of ["{not json", undefined]) {
		const pi = createFakePi();
		const { ctx, notices } = createBellCtx();
		attachGentleShell(pi, { mode: "yolo" });
		const writes = loadWithBell(pi, undefined, undefined, raw);

		await pressKey(pi, ctx);

		assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);
		assert.deepEqual(writes, [BELL]);
	}
});

test("a throwing bell writer leaves the notice and the press intact", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	const { calls } = attachGentleShell(pi, { mode: "yolo" });
	let attempts = 0;
	loadWithBell(pi, undefined, () => {
		attempts += 1;
		throw new Error("bell-boom");
	});

	await pressKey(pi, ctx);
	assert.equal(attempts, 1);
	assert.deepEqual(notices, [{ message: "Permissions: NORMAL", type: "info" }]);

	// The lock was released: the next press rotates again.
	await pressKey(pi, ctx);
	assert.deepEqual(setModes(calls), ["normal", "auto"]);
});

test("the bell rings even when there is no UI to show the notice, as long as the mode is tui", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createBellCtx();
	ctx.hasUI = false;
	attachGentleShell(pi, { mode: "yolo" });
	const writes = loadWithBell(pi);

	await pressKey(pi, ctx);

	assert.deepEqual(notices, []);
	assert.deepEqual(writes, [BELL]);
});

test("a config getter that throws keeps super-yolo out of the rotation", async () => {
	const calls: string[] = [];
	const bus = {
		emit: (_channel: string, data: unknown) => {
			(data as { respond: (adapter: unknown) => void }).respond({
				readMode: () => "yolo",
				setMode: (mode: string) => {
					calls.push(mode);
					return true;
				},
				dispose: () => {},
			});
		},
	};

	const outcome = await cycleMode({
		bus,
		context: {},
		includeSuperYolo: () => {
			throw new Error("config-boom");
		},
	});

	assert.deepEqual(calls, ["normal"]);
	assert.deepEqual(outcome, { kind: "changed", from: "yolo", to: "normal" });
});
