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

test("resolves Pi's agent directory from PI_CODING_AGENT_DIR, expanding a leading tilde", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir");
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/agent-dir" }), join(homedir(), "agent-dir"));
	assert.equal(resolveAgentDir({}), join(homedir(), ".pi", "agent"));
});

// ---- T3: configurable key ----


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
