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

// ---- T3b: capturing the key with the keyboard ------------------------------

type CaptureCtx = ReturnType<typeof createCtx> & { customCalls: number };

/** A TUI ctx whose `custom` behaves like Pi's: it builds the component and drives it with `keys`. */
function createTuiCtx(keys: string[] | "undefined") {
	const base = createCtx();
	const result = base as CaptureCtx;
	result.customCalls = 0;
	base.ctx.mode = "tui";
	base.ctx.ui.custom = async (factory) => {
		result.customCalls += 1;
		if (keys === "undefined") return undefined;
		let value: unknown;
		let closed = false;
		const component = (await factory({}, {}, undefined, (v: unknown) => {
			value = v;
			closed = true;
		})) as { handleInput(data: string): void };
		for (const key of keys) if (!closed) component.handleInput(key);
		return value;
	};
	return result;
}

test("/mode-cycle key with a TUI captures the key, writes the file and shows the saved notice", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createExtension(pi, dir);
	const tui = createTuiCtx(["\x1b[110;3u", "\r"]);

	await runCommand(pi, tui.ctx, "key");

	assert.equal(tui.customCalls, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "gentle-mode-cycle.json"), "utf8")), { key: "alt+n" });
	assert.equal(tui.notices.length, 1);
	assert.match(tui.notices[0]?.message ?? "", /Key saved: alt\+n/);
	assert.match(tui.notices[0]?.message ?? "", /\/reload/);
});

test("cancelling the capture writes nothing and shows nothing", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createExtension(pi, dir);
	const tui = createTuiCtx(["\x1b[110;3u", "\x1b"]);

	await runCommand(pi, tui.ctx, "key");

	assert.equal(tui.customCalls, 1);
	assert.equal(existsSync(join(dir, "gentle-mode-cycle.json")), false);
	assert.deepEqual(tui.notices, []);
});

test("a custom() that returns undefined is a cancel", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createExtension(pi, dir);
	const tui = createTuiCtx("undefined");

	await runCommand(pi, tui.ctx, "key");

	assert.equal(tui.customCalls, 1);
	assert.equal(existsSync(join(dir, "gentle-mode-cycle.json")), false);
	assert.deepEqual(tui.notices, []);
});

test("without a TUI, key alone keeps the typed usage and never calls custom()", async () => {
	for (const mode of ["rpc", "print", undefined]) {
		const dir = makeAgentDir();
		const pi = createFakePi();
		createExtension(pi, dir);
		const tui = createTuiCtx(["\x1b[110;3u", "\r"]);
		if (mode === undefined) delete tui.ctx.mode;
		else tui.ctx.mode = mode;

		await runCommand(pi, tui.ctx, "key");

		assert.equal(tui.customCalls, 0, `mode ${mode}`);
		assert.equal(existsSync(join(dir, "gentle-mode-cycle.json")), false);
		assert.equal(tui.notices[0]?.type, "warning");
		assert.match(tui.notices[0]?.message ?? "", /exactly one key/);
	}
});

test("if pi-tui cannot be loaded, key alone falls back to the typed usage without crashing", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createGentleModeCycle(pi as never, { agentDir: dir, loadKeyTools: async () => { throw new Error("no pi-tui"); } });
	const tui = createTuiCtx(["\x1b[110;3u", "\r"]);

	await runCommand(pi, tui.ctx, "key");

	assert.equal(tui.customCalls, 0);
	assert.equal(existsSync(join(dir, "gentle-mode-cycle.json")), false);
	assert.match(tui.notices[0]?.message ?? "", /exactly one key/);
});

test("a custom() that throws shows the typed usage instead of crashing", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createExtension(pi, dir);
	const tui = createTuiCtx([]);
	tui.ctx.ui.custom = async () => {
		throw new Error("boom");
	};

	await runCommand(pi, tui.ctx, "key");

	assert.equal(existsSync(join(dir, "gentle-mode-cycle.json")), false);
	assert.match(tui.notices[0]?.message ?? "", /exactly one key/);
});

test("the typed form still works in a TUI and never opens the capture", async () => {
	const dir = makeAgentDir();
	const pi = createFakePi();
	createExtension(pi, dir);
	const tui = createTuiCtx(["\r"]);

	await runCommand(pi, tui.ctx, "key alt+n");

	assert.equal(tui.customCalls, 0);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "gentle-mode-cycle.json"), "utf8")), { key: "alt+n" });
});

test("the usage notice documents that key alone captures", () => {
	const { usageNotice } = notices_;
	assert.match(usageNotice(), /key \[<key\|off>\]/);
});
