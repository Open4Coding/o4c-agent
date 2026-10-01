import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../ui/InputBox.js';

// Standard terminal escape/control sequences Ink's useInput parses into named keys. Built via
// String.fromCharCode rather than string-literal escapes so the exact bytes sent are unambiguous.
const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const BACKSPACE = String.fromCharCode(127);
const UP = ESC + '[A';
const DOWN = ESC + '[B';
const LEFT = ESC + '[D';
const RIGHT = ESC + '[C';
const CTRL_A = String.fromCharCode(1);
const CTRL_E = String.fromCharCode(5);
const CTRL_U = String.fromCharCode(21);
const CTRL_J = String.fromCharCode(10);
const ALT_ENTER = ESC + ENTER;
// The cursor cell's own SGR pair (InputBox.tsx's CURSOR_BG_ON/CURSOR_BG_OFF) - amber truecolor
// background (`theme.accent` = #FFBF00 = rgb(255,191,0)) on, default-background off. Named here
// rather than inlined at each call site so a future color/approach change only needs updating once.
const CURSOR_ON = `${ESC}[48;2;255;191;0m`;
const CURSOR_OFF = `${ESC}[49m`;
// Kitty keyboard protocol CSI-u form for codepoint 13 (return) with a modifier: parsing is
// purely pattern-based in Ink (see node_modules/ink/build/parse-keypress.js), independent of
// whether the app actually negotiated the protocol with a real terminal - so these bytes are
// exactly what a Kitty-speaking terminal would send for Ctrl+Enter/Shift+Enter, usable here
// without needing a real terminal to test against.
const KITTY_CTRL_ENTER = ESC + '[13;5u'; // modifier 5 = ctrl(4) + 1
const KITTY_SHIFT_ENTER = ESC + '[13;2u'; // modifier 2 = shift(1) + 1

// Ink's useInput subscribes to input inside a useEffect, which runs asynchronously after
// render() returns (and after each state-driven re-render) - not synchronously with it. Every
// write needs to happen after that effect has actually flushed, or the keystroke is dropped
// with no error at all (this is what caused every assertion here to see zero onSubmit calls
// on the first attempt at this test file).
// 30ms, not 10ms - React 19 + Ink 7's internal scheduling (useEffectEvent, discreteUpdates) takes
// measurably longer to settle a keypress into a committed state update than the previous stack
// did. Confirmed empirically: 10ms was flaky, 20ms was reliable in isolation; 30ms gives margin
// for real test-runner contention.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function type(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

async function press(stdin: { write: (data: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  await tick();
}

test('typing then pressing Enter submits the typed value and clears the box', async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }),
  );
  await tick();

  await type(stdin, 'hello world');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['hello world']);
  assert.equal(lastFrame()?.includes('hello world'), false);
});

test('submitting an empty box calls onSubmit with an empty string (caller decides whether to ignore it)', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['']);
});

test('backspace deletes the character before the cursor', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'abc');
  await press(stdin, BACKSPACE);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['ab']);
});

test('left/right arrows move the cursor so backspace and typing act at the right position', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'ac');
  await press(stdin, LEFT);
  await type(stdin, 'b');
  await press(stdin, RIGHT);
  await type(stdin, 'd');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['abcd']);
});

test('up/down arrow history recall cycles through previously submitted values', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);
  await type(stdin, 'second');
  await press(stdin, ENTER);

  await press(stdin, UP);
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first', 'second', 'first']);
});

test('initialHistory seeds submit-history recall on mount, as a /resume restart handoff would', async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    React.createElement(InputBox, {
      onSubmit: (v) => submitted.push(v),
      initialHistory: ['from a previous process', 'also from before'],
    }),
  );
  await tick();

  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['also from before']);
});

test('onHistoryChange fires with the updated array on every non-blank submit, for a caller to persist', async () => {
  const historySnapshots: string[][] = [];
  const { stdin } = render(
    React.createElement(InputBox, {
      onSubmit: () => {},
      onHistoryChange: (h) => historySnapshots.push([...h]),
    }),
  );
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);
  await type(stdin, 'second');
  await press(stdin, ENTER);
  await press(stdin, ENTER); // blank submit - must not fire onHistoryChange again

  assert.deepEqual(historySnapshots, [['first'], ['first', 'second']]);
});

test('onHistoryChange sees initialHistory-seeded entries too, so a later resave does not drop them', async () => {
  const historySnapshots: string[][] = [];
  const { stdin } = render(
    React.createElement(InputBox, {
      onSubmit: () => {},
      initialHistory: ['seeded'],
      onHistoryChange: (h) => historySnapshots.push([...h]),
    }),
  );
  await tick();

  await type(stdin, 'new one');
  await press(stdin, ENTER);

  assert.deepEqual(historySnapshots, [['seeded', 'new one']]);
});

test('down arrow past the newest history entry restores the in-progress draft, not empty', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'submitted once');
  await press(stdin, ENTER);

  await type(stdin, 'draft in progress');
  await press(stdin, UP);
  await press(stdin, DOWN);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['submitted once', 'draft in progress']);
});

test('down arrow on a fresh draft (not browsing history) clears the box and stores the draft into history', async () => {
  // Real bug found via hands-on testing, 2026-09-26: down-arrow while not already browsing
  // history (nothing recalled via up-arrow yet) and already on the box's last line used to just
  // do nothing - typed text got stuck with no way to clear it this way. Fixed to clear the box,
  // but not silently: the cleared text is pushed into history first (same push + onHistoryChange
  // call a real Enter-submit makes), so it's recallable later and reaches session persistence
  // the same way a submission would, rather than being discarded.
  const submitted: string[] = [];
  const historySnapshots: string[][] = [];
  const { stdin, lastFrame } = render(
    React.createElement(InputBox, {
      onSubmit: (v) => submitted.push(v),
      onHistoryChange: (h) => historySnapshots.push([...h]),
    }),
  );
  await tick();

  await type(stdin, 'an unsent draft');
  await press(stdin, DOWN);

  assert.equal(lastFrame()?.includes('an unsent draft'), false);
  assert.deepEqual(historySnapshots, [['an unsent draft']]);

  // Stored, not just cleared - recallable via up-arrow afterward like any other history entry.
  await press(stdin, UP);
  await press(stdin, ENTER);
  assert.deepEqual(submitted, ['an unsent draft']);
});

test('down arrow on an already-empty box (not browsing history) is a harmless no-op', async () => {
  const historySnapshots: string[][] = [];
  const { stdin } = render(
    React.createElement(InputBox, { onSubmit: () => {}, onHistoryChange: (h) => historySnapshots.push([...h]) }),
  );
  await tick();

  await press(stdin, DOWN);

  assert.deepEqual(historySnapshots, []);
});

test('Ctrl+A/E jump to the start/end of the buffer, Ctrl+U clears it entirely', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello');
  await press(stdin, CTRL_A);
  await type(stdin, 'X');
  await press(stdin, CTRL_E);
  await type(stdin, 'Y');
  await press(stdin, CTRL_U);
  await type(stdin, 'clean');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['clean']);
});

// Real Home/End escape sequences (not the Ctrl-A/Ctrl-E readline convention above), confirmed
// against this project's target terminal (Windows Terminal) with a raw-byte probe, the same way
// Tab vs. Shift+Tab was diagnosed - not guessed from a spec. Ink 7 parses these into native
// key.home/key.end itself; InputBox no longer needs to intercept the raw bytes.
const HOME = ESC + '[1~';
const END = ESC + '[4~';

test('Home/End jump to the start/end of a never-wrapped line (indistinguishable here from the whole buffer)', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello');
  await press(stdin, HOME);
  await type(stdin, 'X');
  await press(stdin, END);
  await type(stdin, 'Y');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['XhelloY']);
});

test('Home/End keep working after /set-style prefills and history recall, not just on a freshly mounted box', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first message');
  await press(stdin, ENTER);
  await press(stdin, UP); // recall it via history
  await press(stdin, HOME);
  await type(stdin, 'X');
  await press(stdin, END);
  await type(stdin, 'Y');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first message', 'Xfirst messageY']);
});

test('Home/End move within the current wrapped row, not the whole buffer, once the line has wrapped', async () => {
  // Regression test for David's correction: "home and end should move to the home and end of
  // the line, not the input text." Uses the same 96-column-wide, two-row-wrapped value as the
  // up/down wrapped-row tests below (94 'A's fill row 0 after the 2-column "> " prompt, "BBBB"
  // is all of row 1) - independently hand-verified with a standalone script before trusting
  // these expected strings, same discipline as the up/down tests.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  const wrapped = `${'A'.repeat(94)}BBBB`;
  stdin.write(wrapped);
  await tick();

  // Ctrl-A (the unchanged, absolute-buffer-start binding - see the Ctrl-A/Ctrl-E test above)
  // gets the cursor onto row 0 at index 0. Pressing Home here would NOT do the same thing:
  // typing left the cursor at the end (row 1), and Home is row-scoped, so it would land on
  // row 1's own start (see the next test) rather than row 0's - Ctrl-A is what still reaches
  // across rows to the true buffer start.
  await press(stdin, CTRL_A); // cursor -> 0, row 0
  await press(stdin, END); // must stop at the end of row 0, not skip to the end of the buffer
  await type(stdin, 'Z');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [`${'A'.repeat(94)}Z${'BBBB'}`]);
});

test('Home then End on row 1 of a wrapped line round-trips to that row\'s start and end, not the buffer\'s', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  const wrapped = `${'A'.repeat(94)}BBBB`;
  stdin.write(wrapped);
  await tick(); // cursor at the end (98), row 1

  await press(stdin, HOME); // row 1's home is index 94, the first 'B' - not index 0
  await type(stdin, 'Z'); // splits the B's: confirms Home actually moved the cursor
  await press(stdin, END); // row 1 is also the *last* row, so its end IS the buffer's end here
  await type(stdin, 'Q'); // appended at the very end, distinguishing this from the previous test
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [`${'A'.repeat(94)}ZBBBBQ`]);
});

test('Ctrl+U only kills from line-start to the cursor, leaving text after it in place', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello world');
  for (let i = 0; i < 6; i++) await press(stdin, LEFT); // cursor between "hello" and " world"
  await press(stdin, CTRL_U);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [' world']);
});

test('up-arrow right after Ctrl+U yanks the killed text back in at the cursor', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello world');
  for (let i = 0; i < 6; i++) await press(stdin, LEFT); // cursor between "hello" and " world"
  await press(stdin, CTRL_U);
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['hello world']);
});

test('a second up-arrow after the yank is consumed falls through to normal history recall', async () => {
  // Checks the final submitted value only, not an intermediate lastFrame() snapshot - Ink's
  // reconciliation across two rapid state-updating keystrokes (Ctrl+U then Up) can be caught
  // mid-repaint by a frame snapshot one tick in, even though the underlying state is already
  // correct (confirmed by tracing it directly). If the kill ring wrongly yanked a *second* time
  // instead of falling through to history, the final value would be 'betabeta' or similar, not
  // a clean 'alpha' - so this still fully exercises the fallthrough without relying on a frame
  // captured at a fragile instant.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'alpha');
  await press(stdin, ENTER);

  await type(stdin, 'beta');
  await press(stdin, CTRL_U); // cursor is at the end, kills the whole word
  await press(stdin, UP); // first up-arrow: yanks 'beta' back
  await press(stdin, UP); // kill ring is now empty: falls through to real history recall
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['alpha', 'alpha']);
});

test('the kill ring is cleared on submit, so it does not bleed into the next message', async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'killed text');
  await press(stdin, CTRL_U);
  await press(stdin, ENTER); // submits '', and should clear the kill ring too

  await type(stdin, 'fresh');
  await press(stdin, UP); // no history yet and no kill ring - must be a no-op, not a stale yank

  assert.equal(lastFrame()?.includes('killed text'), false);
  await press(stdin, ENTER);
  assert.deepEqual(submitted, ['', 'fresh']);
});

test('editing works even when disabled=true, matching the type-ahead queueing design', async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    React.createElement(InputBox, { disabled: true, onSubmit: (v) => submitted.push(v) }),
  );
  await tick();

  await type(stdin, 'queued message');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['queued message']);
});

test('the cursor stays visible while disabled=true, not just editable - real bug found via direct user report', async () => {
  // "when this is thinking, the cursor disappears, you give it a prompt there is no cursor" -
  // disabled=true (the mid-turn "thinking" state) still genuinely accepts keystrokes for queueing
  // (the test above), so hiding the cursor made it look like typing wasn't going anywhere when it
  // actually was. The cursor cell must still render even though the box is disabled.
  const { stdin, lastFrame } = render(React.createElement(InputBox, { disabled: true, onSubmit: () => {} }));
  await tick();

  await type(stdin, 'x');
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes(CURSOR_ON), 'cursor must still be visible while disabled=true');
});

// The test harness's fake Stdout (ink-testing-library) always reports 100 columns, fixed - see
// contentWidth() in InputBox.tsx: border (2) + paddingX*2 (2) = 4 columns of overhead, so content
// is 96 columns wide here. With `wrap="hard"` (fixed-width, no word-wrap, no character elision -
// confirmed directly against wrap-ansi itself before relying on it), row 0 of `prompt + value`
// holds exactly 96 characters: the 2-character "> " prompt plus the first 94 characters of
// `value`. A `value` of 94 'A's followed by "BBBB" therefore wraps into exactly two rows: row 0 is
// "> " + all 94 'A's, row 1 is "BBBB" alone - a value chosen specifically so the row 1 content
// (the B's) doesn't overlap the prompt at all, keeping the expected math unambiguous.
const WRAPPED_TWO_ROW_VALUE = `${'A'.repeat(94)}BBBB`;

test('up arrow moves the cursor up one wrapped row, preserving column, before ever touching history', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  // One paste-shaped write, not 98 individual keystrokes - matches how InputBox actually
  // receives a long single "line" (see the paste-sanitization test above) and keeps this test
  // fast. Cursor ends at the very end (index 98), which is row 1, column 4 (one past the last
  // "B") - column 4 on row 0 is the 3rd and 4th 'A' (columns 0-1 are the prompt itself).
  stdin.write(WRAPPED_TWO_ROW_VALUE);
  await tick();

  await press(stdin, UP);
  // Landing on row 0 at column 4 means the cursor is now 2 characters into the 'A' run (column 4
  // minus the prompt's 2 columns) - typing a marker there must split the 'A's at exactly that
  // point, not land anywhere in the prompt or elsewhere in the run.
  await type(stdin, 'Z');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [`AAZ${'A'.repeat(92)}BBBB`]);
});

test('down arrow moves the cursor down one wrapped row, preserving column, before ever touching history', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  stdin.write(WRAPPED_TWO_ROW_VALUE);
  await tick();
  // Ctrl-A (absolute buffer start), not Home - Home is row-scoped (see the dedicated Home/End
  // wrapped-row tests above) and typing left the cursor on row 1, so Home here would land on
  // row 1's own start instead of row 0's. Index 0 is column 2 on row 0 (columns 0-1 are the
  // "> " prompt itself). Right once moves to index 1, column 3.
  await press(stdin, CTRL_A);
  await press(stdin, RIGHT);
  // Column 3 on row 1 is index 97 of `value` (row 1 starts at value index 94, the first 'B') -
  // between the 3rd and 4th 'B'.
  await press(stdin, DOWN);
  await type(stdin, 'Z');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [`${'A'.repeat(94)}BBBZB`]);
});

test('up/down still fall through to history recall once already on the only (single-row) line', async () => {
  // Regression guard: the new wrapped-row movement above must not swallow up/down for the
  // overwhelming common case - short input that never wraps at all, where row 0 is both the
  // top and bottom row simultaneously. This is exactly the pre-existing history test above,
  // kept here as a belt-and-suspenders check right next to the new wrapped-row logic so a
  // future change to the row-movement guard's boundary condition (row > 0 / row < numRows - 1)
  // gets caught immediately if it accidentally starts intercepting the single-row case too.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);
  await type(stdin, 'second');
  await press(stdin, ENTER);

  await press(stdin, UP);
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first', 'second', 'first']);
});

test('a pasted chunk with embedded carriage returns is normalized to real newlines, preserving blank lines', async () => {
  // Regression test for two bugs found on the same code path, at two different points in this
  // plan. First (#3): a real terminal delivers a multi-line paste as ONE `input` string on ONE
  // `useInput` callback, with bare `\r` (not `\n`) as the line separator - confirmed via a raw
  // stdin capture of an actual paste. A literal `\r` written straight to the terminal doesn't
  // start a new line - it snaps the cursor back to column 0 of the *current* row - so leaving it
  // in `value` unconverted corrupted the rendered box (later "lines" overwrote the start of
  // earlier ones on the same row). Originally (before #5a existed) fixed by collapsing every run
  // of line breaks to a single space, since the box couldn't render more than one line yet.
  // Second (found once #5a made real multi-line editing possible): David reported that
  // space-collapsing as its own bug - "paste multi line does not maintain the cr lf" - pasting a
  // multi-line snippet should produce a multi-line entry now, not one long space-joined line.
  // Fixed: every `\r`/`\n` becomes a real `\n` instead (a Windows-style `\r\n` pair collapses to
  // just one `\n`, not two) - deliberately NOT collapsing runs of them, so a blank line in the
  // original content (a run of two bare `\r`s here) survives as a genuine blank line.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  stdin.write('line one\r\rline two\rline three');
  await tick();
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['line one\n\nline two\nline three']);
});

test('a pasted chunk with Windows-style CRLF line endings does not double every line', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  stdin.write('line one\r\nline two\r\nline three');
  await tick();
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['line one\nline two\nline three']);
});

test('a long pasted word repeated many times wraps at spaces in the rendered frame, not mid-word', async () => {
  // Regression test for David's live report: "the words wrap, the words get split in the
  // middle" - reproduced by pasting a long repeated word (matching his real repro: the same word
  // 20-40 times in a row) against the *pre-fix* code, which used <Text wrap="hard"> and split
  // "motherfather" mid-character at every row boundary. Fixed by switching to wrap="wrap" and
  // rewriting inputBoxLayout.ts's cursor math to match (see that module's own doc comment).
  // Checks the actual rendered frame, not just the math module, so it catches a real regression
  // in how InputBox.tsx wires wrap-ansi's output to the screen, not just in the math in isolation.
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: () => {} }));
  await tick();

  const pasted = Array(30).fill('motherfather').join(' ');
  stdin.write(pasted);
  await tick(100);

  const frame = lastFrame() ?? '';
  const contentLines = frame.split('\n').slice(1, -1); // drop the top/bottom border rows
  // Strip the border/padding chars and any inverse-video SGR codes (the cursor cell), then every
  // whitespace-separated token on every line must be either empty or the whole word "motherfather"
  // - if it were still splitting mid-word, some token would be a bare fragment like "mot".
  for (const l of contentLines) {
    const stripped = l.replace(/\x1B\[[\d;]+m/g, '').replace(/^│/, '').replace(/│$/, '').trim();
    const tokens = stripped.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      // '>' is the box's own prompt marker (line 0 only), not a word-wrap fragment.
      assert.ok(
        token === 'motherfather' || token === '>',
        `found a word fragment in rendered line: "${stripped}"`,
      );
    }
  }
});

test('Ctrl+J inserts a literal newline instead of submitting', async () => {
  // Regression test for #4a: Ctrl+J (linefeed, 0x0A) is the universal newline-insertion
  // fallback that works on every terminal with zero protocol negotiation - unlike
  // Ctrl+Enter/Shift+Enter, it never even needs the Kitty keyboard protocol to be
  // distinguished from plain Enter.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'line one');
  await press(stdin, CTRL_J);
  await type(stdin, 'line two');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['line one\nline two']);
});

test('Alt+Enter inserts a literal newline instead of submitting', async () => {
  // Regression test for #4a: Alt+Enter arrives as the legacy "meta sends escape" sequence
  // (ESC + \r), which Ink parses as key.return + key.meta on virtually every terminal by
  // default - no Kitty protocol needed.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'line one');
  await press(stdin, ALT_ENTER);
  await type(stdin, 'line two');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['line one\nline two']);
});

test('Ctrl+Enter and Shift+Enter insert a literal newline on a Kitty-speaking terminal', async () => {
  // Regression test for #4a: on a terminal that speaks the Kitty keyboard protocol,
  // Ctrl+Enter/Shift+Enter arrive as CSI-u sequences carrying a real modifier bit for
  // codepoint 13 (return), which Ink parses into key.return + key.ctrl/key.shift - these two
  // combos are otherwise indistinguishable from plain Enter on any non-Kitty terminal.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'one');
  await press(stdin, KITTY_CTRL_ENTER);
  await type(stdin, 'two');
  await press(stdin, KITTY_SHIFT_ENTER);
  await type(stdin, 'three');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['one\ntwo\nthree']);
});

test('up-arrow moves the cursor within a short real multi-line draft instead of immediately recalling history', async () => {
  // Regression test for a real bug found via a live-terminal report (David: up/down "worked" for
  // him, but only because his test text happened to be long enough to wrap past the terminal
  // width by sheer character count): before inputBoxLayout.ts, Up/Down used a flat single-line
  // row formula with no idea an embedded '\n' forces a row break. For a SHORT multi-line draft
  // (well under one terminal-width row), the whole thing computed as "row 0" regardless of the
  // newline, so Up fell straight through to history recall and silently swapped out the
  // in-progress two-line draft instead of moving within it - reproduced directly against the
  // pre-fix code with ink-testing-library before this fix was written.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);

  await type(stdin, 'line one');
  await press(stdin, CTRL_J);
  await type(stdin, 'line two');
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first', 'line one\nline two']);
});

test('up-arrow reaches submit history only after exhausting a real multi-line draft\'s own lines', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);

  await type(stdin, 'line one');
  await press(stdin, CTRL_J);
  await type(stdin, 'line two');
  await press(stdin, UP); // lands within "line one" - its own single row is the box's top row
  await press(stdin, UP); // already at the top - this one recalls history instead
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first', 'first']);
});

test('Home/End on a real multi-line value stay within the current logical line, not the whole buffer', async () => {
  // Regression test: with real multi-line content now possible (#4a), David's original Home/End
  // semantics ("home and end should move to the home and end of the line, not the input text")
  // extend naturally to "the current logical line", not the whole multi-line buffer - jumping to
  // line 0 from line 1 would be exactly the bug those semantics were fixed to avoid, just at a
  // different scope.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'aaa');
  await press(stdin, CTRL_J);
  await type(stdin, 'bbb');
  await press(stdin, HOME);
  await type(stdin, 'X');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['aaa\nXbbb']);
});

test('Escape calls onEscape and never leaks a raw ESC byte into the value', async () => {
  // Regression test: confirmed directly against Ink's parser (parse-keypress.js) that a bare
  // Escape has no named `nonAlphanumericKeys` entry the way Tab/Home/End/arrows do, so its
  // `input` stays as the raw ESC byte and - if left unhandled - falls straight through to plain
  // character insertion instead of being cleared to ''. Used to cancel an in-flight turn (see
  // App.tsx's handleEscape) while the "Thinking..." spinner is up.
  const submitted: string[] = [];
  let escapeCount = 0;
  const { stdin } = render(
    React.createElement(InputBox, {
      onSubmit: (v) => submitted.push(v),
      onEscape: () => {
        escapeCount += 1;
      },
    }),
  );
  await tick();

  await type(stdin, 'hello');
  await press(stdin, ESC);
  await press(stdin, ENTER);

  assert.equal(escapeCount, 1);
  // If Escape had leaked through to character insertion, this would be 'hello\x1B' instead.
  assert.deepEqual(submitted, ['hello']);
});

test('Escape is swallowed even with no onEscape handler passed', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello');
  await press(stdin, ESC);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['hello']);
});

test('the cursor cell renders on the content row, not spliced into the border below it', async () => {
  // Regression test for the "stray green box" bug: giving <Text> multiple separate
  // string/Text children (prompt, before, cursor, after, as four sibling expressions) could
  // push Ink's layout by one phantom row, splicing the cursor's inverse cell into the Box's
  // bottom border row instead of the content row - confirmed by capturing Ink's actual raw
  // output bytes both from a real terminal and from this same test harness. The fix
  // concatenates everything into one string before it ever reaches <Text>.
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: () => {} }));
  await tick();

  await type(stdin, '/');

  const lines = (lastFrame() ?? '').split('\n');
  const contentLine = lines[1] ?? '';
  // Strip color SGR codes (e.g. the border's `\x1B[37m`/`\x1B[39m`) before checking box-drawing
  // purity - whether the border is colored is unrelated to this regression test, and different
  // Ink/chalk versions detect terminal color support differently in this test harness. What
  // this is actually checking is that nothing else (like the cursor's cell) got spliced into
  // the border row.
  const borderLine = (lines[2] ?? '').replace(/\x1B\[[\d;]+m/g, '');
  // The border row must be untouched box-drawing characters only - no inverse-video escape
  // code and no bare space breaking up the run of dashes.
  assert.equal(/^╰─+╯$/.test(borderLine), true);
  // The cursor's highlighted cell belongs on the content row, right after "> /".
  assert.ok(contentLine.includes(`> /${CURSOR_ON} ${CURSOR_OFF}`));
});

test('the cursor stays visible at the end of a non-final line, instead of vanishing on the invisible newline', async () => {
  // Regression test for David's live report: "go to the top line, and hit ctrl-j the cursor
  // disappears, it re-appears when you down arrow to the text moved down." Root cause:
  // highlighting the character AT the cursor is how this box fakes a cursor, and there's no
  // visible glyph to invert when that character is a real `\n` (end of a non-final logical
  // line) - the highlight SGR codes end up wrapping an invisible character, so the frame has no
  // visible highlight anywhere at all. Reproduced directly against the pre-fix code:
  // `frame.includes(CURSOR_ON)` was false the moment the cursor landed at the end of "line one",
  // even before pressing Ctrl+J again.
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: () => {} }));
  await tick();

  await type(stdin, 'line one');
  await press(stdin, CTRL_J);
  await type(stdin, 'line two');
  await press(stdin, CTRL_A); // absolute start (line 0)
  await press(stdin, END); // end of the current row - lands right before the '\n'

  const frame = lastFrame() ?? '';
  // A highlighted *space* right after "line one" - inserted before the real '\n', not replacing
  // it, so "line one" still ends its own row and "line two" still starts a fresh one below it.
  const lines = frame.split('\n');
  const lineOneRow = lines.find((l) => l.includes('line one'));
  assert.ok(
    lineOneRow?.includes(`line one${CURSOR_ON} ${CURSOR_OFF}`),
    `cursor not shown at end of line one: "${lineOneRow}"`,
  );
  const lineTwoRow = lines.find((l) => l.includes('line two'));
  assert.ok(lineTwoRow && !lineTwoRow.includes(CURSOR_ON), 'line two should not carry the highlight');
});

test('the cursor stays on its own (empty) line, not several rows away, when several newlines are inserted in a row', async () => {
  // Regression test for David's own follow-up finding a real bug in the first attempt at the
  // fix above: "if 3 lines are inserted ctrl-j x 3 at the beginning and you up two... the green
  // box start moving down again." Three Ctrl+J presses at position 0 creates three consecutive
  // *empty* logical lines - each one's own "start" position is immediately its own '\n', with no
  // real character anywhere on that line at all. The first fix (look forward past every `\n` to
  // the next real character) skipped straight over all three empty lines and highlighted
  // unrelated content several rows below where the cursor logically was - the same "highlight
  // lands in the wrong row" shape as the very first bug this plan ever fixed (#2's stray green
  // box), reintroduced a different way. Corrected: the highlight is a space *inserted before*
  // the real `\n`, never skipping past it, so it always lands on the cursor's own actual row.
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: () => {} }));
  await tick();

  await type(stdin, 'original');
  await press(stdin, CTRL_A); // start of "original"
  await press(stdin, CTRL_J);
  await press(stdin, CTRL_J);
  await press(stdin, CTRL_J); // three empty lines now precede "original"
  await press(stdin, UP);
  await press(stdin, UP); // now on the second (empty) line, not the fourth ("original")

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  // Exactly one content row carries the highlight, and it must not be "original"'s own row -
  // the cursor is two rows above that, on an empty line with nothing else on it.
  const highlighted = lines.filter((l) => l.includes(CURSOR_ON));
  assert.equal(highlighted.length, 1, `expected exactly one highlighted row, got: ${JSON.stringify(lines)}`);
  assert.ok(!highlighted[0].includes('original'), 'the highlight must not have jumped down to "original"');
});

test('while disabled (a turn running) the cursor stays solid and the box stops repainting on a blink timer', async () => {
  const { frames } = render(React.createElement(InputBox, { disabled: true }));
  await tick();
  const before = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 1300)); // would have crossed two 530ms blink toggles
  assert.equal(frames.length, before, 'no blink repaints while disabled');
  assert.ok(frames[frames.length - 1].includes(CURSOR_ON), 'cursor still visible');
});

test('when enabled the cursor still blinks', async () => {
  const { frames } = render(React.createElement(InputBox, {}));
  await tick();
  const before = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(frames.length > before, 'blink repaints while idle');
});

test('the cursor stops blinking (holds solid) once the blink window after the last keystroke has passed', async () => {
  const { frames } = render(React.createElement(InputBox, { blinkWindowMs: 700 }));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 1600)); // past the window
  const before = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 1600)); // would have toggled ~3 times
  assert.equal(frames.length, before, 'no repaints while idle');
  assert.ok(frames[frames.length - 1].includes(CURSOR_ON), 'the cursor is left solid and visible');
});

test('typing after the cursor has gone solid makes it blink again', async () => {
  const { frames, stdin } = render(React.createElement(InputBox, { blinkWindowMs: 700 }));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await type(stdin, 'a');
  const before = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 650)); // one 530 ms toggle, inside the new window
  assert.ok(frames.length > before, 'blinking resumed after the keystroke');
});
