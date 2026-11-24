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
