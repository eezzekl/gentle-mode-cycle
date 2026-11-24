import assert from "node:assert/strict";
import { test } from "node:test";

import { createKeyCapture, loadKeyTools, type KeyTools } from "../lib/key-capture.ts";

// Real parser: the host supplies pi-tui at runtime, the devDependency stands in here.
const tools = (await loadKeyTools()) as KeyTools;

function open(keybindings?: unknown) {
	const results: Array<string | undefined> = [];
	const component = createKeyCapture(tools, keybindings as never, (value) => results.push(value));
	const text = () => component.render(80).join("\n");
	return { component, results, text };
}

// Terminals with the kitty keyboard protocol (Pi enables it) report modified keys as CSI u.
const ALT_N = "\x1b[110;3u";
const SHIFT_N = "\x1b[110;2u";

test("the real pi-tui parser is available to the capture", () => {
	assert.ok(tools, "pi-tui must load");
});

test("alt+n is shown live and can be confirmed", () => {
	const { component, results, text } = open();
	component.handleInput(ALT_N);
	assert.match(text(), /alt\+n/);
	component.handleInput("\r");
	assert.deepEqual(results, ["alt+n"]);
});

test("shift+n is shown as shift+n, not as a capital letter", () => {
	const { component, results, text } = open();
	component.handleInput(SHIFT_N);
	assert.match(text(), /shift\+n/);
	component.handleInput("\r");
	assert.deepEqual(results, ["shift+n"]);
});

test("a capital N without protocol info is a bare n: shown with the reason and not confirmable", () => {
	const { component, results, text } = open();
	component.handleInput("N");
	assert.match(text(), /needs a modifier/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
});

test("a bare n is shown with the reason and cannot be confirmed", () => {
	const { component, results, text } = open();
	component.handleInput("n");
	assert.match(text(), /\bn\b/);
	assert.match(text(), /needs a modifier/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
});

test("a legacy alt+letter the parser maps to an arrow is shown, explained and not confirmable", () => {
	const { component, results, text } = open();
	component.handleInput("\x1bn"); // legacy terminal: ESC n, which Pi maps to alt+down
	assert.match(text(), /alt\+down/);
	assert.match(text(), /legacy sequence/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
});

test("a legacy alt+letter the parser keeps is still confirmable", () => {
	const { component, results, text } = open();
	component.handleInput("\x1bm"); // legacy terminal: ESC m, which really is alt+m
	assert.match(text(), /alt\+m/);
	assert.doesNotMatch(text(), /legacy sequence/);
	component.handleInput("\r");
	assert.deepEqual(results, ["alt+m"]);
});

test("reports a Pi built-in binding that already owns the combination, and still saves it", () => {
	const bindings = { getEffectiveConfig: () => ({ "app.models.reorderDown": "shift+alt+n" }) };
	const { component, results, text } = open(bindings);
	component.handleInput("\x1b[110;4u"); // shift+alt+n, as Pi writes it in another modifier order
	assert.match(text(), /app\.models\.reorderDown/);
	assert.match(text(), /Pi's built-in/);
	component.handleInput("\r");
	assert.deepEqual(results, ["shift+alt+n"]);
});

test("refuses a combination bound to a reserved Pi binding, because the key would never fire", () => {
	const bindings = { getEffectiveConfig: () => ({ "app.model.cycleForward": "alt+n" }) };
	const { component, results, text } = open(bindings);
	component.handleInput(ALT_N);
	assert.match(text(), /app\.model\.cycleForward/);
	assert.match(text(), /reserved by Pi/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
});

test("a reserved binding wins a key it shares with an ordinary one", () => {
	const bindings = { getEffectiveConfig: () => ({ "app.models.reorderDown": "alt+n", "app.interrupt": "alt+n" }) };
	const { component, text } = open(bindings);
	component.handleInput(ALT_N);
	assert.match(text(), /app\.interrupt/);
	assert.match(text(), /reserved by Pi/);
});

test("a free combination shows no conflict, and a throwing binding table degrades quietly", () => {
	const free = open({ getEffectiveConfig: () => ({ "app.models.reorderDown": "ctrl+x" }) });
	free.component.handleInput(ALT_N);
	assert.doesNotMatch(free.text(), /In use:/);
	free.component.handleInput("\r");
	assert.deepEqual(free.results, ["alt+n"]);

	const broken = open({
		getEffectiveConfig: () => {
			throw new Error("boom");
		},
	});
	broken.component.handleInput(ALT_N);
	assert.doesNotMatch(broken.text(), /In use:/);
	broken.component.handleInput("\r");
	assert.deepEqual(broken.results, ["alt+n"]);
});

test("Backspace clears a legacy ambiguity", () => {
	const { component, results, text } = open();
	component.handleInput("\x1bn");
	assert.match(text(), /legacy sequence/);
	component.handleInput("\x7f");
	assert.match(text(), /waiting for a key/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
});

test("modifiers are normalized to ctrl, shift, alt, super", () => {
	const { component, results } = open();
	component.handleInput("\x1b[110;4u"); // parser reports shift+alt+n
	component.handleInput("\r");
	assert.deepEqual(results, ["shift+alt+n"]);
});

test("Backspace clears the capture and Enter then does nothing", () => {
	const { component, results, text } = open();
	component.handleInput(ALT_N);
	component.handleInput("\x7f");
	assert.doesNotMatch(text(), /alt\+n/);
	component.handleInput("\r");
	assert.deepEqual(results, []);
	component.handleInput("\x1b[110;3u");
	component.handleInput("\r");
	assert.deepEqual(results, ["alt+n"]);
});

test("Escape cancels with no value", () => {
	const { component, results } = open();
	component.handleInput(ALT_N);
	component.handleInput("\x1b");
	assert.deepEqual(results, [undefined]);
});

test("Enter and Escape follow the host keybindings when given", () => {
	const keybindings = { matches: (data: string, id: string) => (id === "tui.select.confirm" ? data === "C" : id === "tui.select.cancel" ? data === "X" : false) };
	const { component, results } = open(keybindings);
	component.handleInput(ALT_N);
	component.handleInput("\r"); // not the confirm key here: captured as a key instead
	assert.deepEqual(results, []);
	component.handleInput(ALT_N);
	component.handleInput("C");
	assert.deepEqual(results, ["alt+n"]);
});

test("an unrecognized sequence is ignored and never throws", () => {
	const { component, results, text } = open();
	component.handleInput(ALT_N);
	assert.doesNotThrow(() => component.handleInput("\x1b[999;99~"));
	assert.match(text(), /alt\+n/);
	assert.deepEqual(results, []);
});

test("render respects the width and invalidate is harmless", () => {
	const { component } = open();
	for (const line of component.render(20)) assert.ok([...line].length <= 20, line);
	assert.doesNotThrow(() => component.invalidate());
});
