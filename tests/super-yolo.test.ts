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

test("turning super-yolo off while the mode is being read cannot land on super-yolo", async () => {
	const dir = makeAgentDir({ includeSuperYolo: true });
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
			dispose: () => {},
		});
	});
	createExtension(pi, dir);

	const press = pressKey(pi, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await runCommand(pi, ctx, "super-yolo off");
	late.resolve("yolo");
	await press;

	assert.deepEqual(calls, ["normal"]);
	assert.deepEqual(notices, [
		{ message: "super-yolo: not included in the rotation.", type: "info" },
		{ message: "Permissions: NORMAL", type: "info" },
	]);
});

// ---- T4: super-yolo opt-in ----------------------------------------------------

test("super-yolo on: normal → auto → yolo → super-yolo → normal", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, makeAgentDir({ includeSuperYolo: true }));

	for (let i = 0; i < 4; i++) await pressKey(pi, ctx);

	assert.deepEqual(setModes(calls), ["auto", "yolo", "super-yolo", "normal"]);
});

test("super-yolo off: yolo → normal and never reaches super-yolo", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, makeAgentDir({ includeSuperYolo: false }));

	for (let i = 0; i < 6; i++) await pressKey(pi, ctx);

	assert.deepEqual(setModes(calls), ["auto", "yolo", "normal", "auto", "yolo", "normal"]);
});

test("super-yolo off and current super-yolo goes to normal", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "super-yolo" });
	createExtension(pi, makeAgentDir({ includeSuperYolo: false }));

	await pressKey(pi, ctx);
	await pressKey(pi, ctx);

	assert.deepEqual(setModes(calls), ["normal", "auto"]);
});

for (const value of ["true", 1, "yes", null, [true], {}]) {
	test(`a non-boolean includeSuperYolo ${JSON.stringify(value)} means off`, async () => {
		const pi = createFakePi();
		const { ctx } = createCtx();
		const { calls } = attachGentleShell(pi, { mode: "yolo" });
		createExtension(pi, makeAgentDir({ includeSuperYolo: value }));

		await pressKey(pi, ctx);

		assert.deepEqual(setModes(calls), ["normal"]);
	});
}

test("a malformed config file means super-yolo off", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "yolo" });
	createExtension(pi, makeAgentDir(undefined, "{ not json"));

	await pressKey(pi, ctx);

	assert.deepEqual(setModes(calls), ["normal"]);
});

test("/mode-cycle super-yolo on writes the file, keeps other fields and confirms", async () => {
	const dir = makeAgentDir({ key: "alt+n", custom: { a: 1 } });
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, dir);

	await runCommand(pi, ctx, "super-yolo on");

	assert.deepEqual(readConfigFile(dir), { key: "alt+n", custom: { a: 1 }, includeSuperYolo: true });
	assert.deepEqual(notices, [{ message: "super-yolo: included in the rotation (applies to the next press).", type: "info" }]);
	assert.deepEqual(calls, [], "the toggle never rotates");
});

test("/mode-cycle super-yolo off writes the file, keeps other fields and confirms", async () => {
	const dir = makeAgentDir({ key: "alt+n", includeSuperYolo: true, custom: { a: 1 } });
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "normal" });
	createExtension(pi, dir);

	await runCommand(pi, ctx, "super-yolo off");

	assert.deepEqual(readConfigFile(dir), { key: "alt+n", includeSuperYolo: false, custom: { a: 1 } });
	assert.deepEqual(notices, [{ message: "super-yolo: not included in the rotation.", type: "info" }]);
	assert.deepEqual(calls, []);
});

test("a toggle applies on the very next press, without a reload", async () => {
	const pi = createFakePi();
	const { ctx } = createCtx();
	const { calls } = attachGentleShell(pi, { mode: "auto" });
	createExtension(pi, makeAgentDir());

	await pressKey(pi, ctx); // auto → yolo
	await runCommand(pi, ctx, "super-yolo on");
	await pressKey(pi, ctx); // yolo → super-yolo
	await runCommand(pi, ctx, "super-yolo off");
	await pressKey(pi, ctx); // super-yolo → normal

	assert.deepEqual(setModes(calls), ["yolo", "super-yolo", "normal"]);
});

test("a press that lands on super-yolo shows Permissions: SUPER-YOLO", async () => {
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	attachGentleShell(pi, { mode: "yolo" });
	createExtension(pi, makeAgentDir({ includeSuperYolo: true }));

	await pressKey(pi, ctx);

	assert.deepEqual(notices, [{ message: "Permissions: SUPER-YOLO", type: "info" }]);
});

for (const bad of ["", "maybe", "ON", "true", "on off", "on extra"]) {
	test(`/mode-cycle super-yolo ${JSON.stringify(bad)} is rejected, does not rotate and does not write`, async () => {
		const dir = makeAgentDir();
		const pi = createFakePi();
		const { ctx, notices } = createCtx();
		const { calls } = attachGentleShell(pi, { mode: "yolo" });
		createExtension(pi, dir);

		await runCommand(pi, ctx, `super-yolo ${bad}`);

		assert.deepEqual(notices, [{ message: 'super-yolo: expected "on" or "off".', type: "warning" }]);
		assert.deepEqual(calls, []);
		assert.equal(existsSync(join(dir, CONFIG_FILE)), false);
	});
}

test("a failed save of the toggle warns and does not claim success", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	const { ctx, notices } = createCtx();
	// A directory where the file should be makes the rename fail.
	mkdirSync(join(dir, CONFIG_FILE));
	createExtension(pi, dir);

	await runCommand(pi, ctx, "super-yolo on");

	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /Could not save/);
});

test("the usage notice lists super-yolo on|off", () => {
	assert.match(notices_.usageNotice(), /\| \/mode-cycle super-yolo on\|off/);
});
