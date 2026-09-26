/**
 * Curated Construct 3 pitfalls, served as construct3://docs/pitfalls.
 *
 * Items come from komabear/c3-skill (MIT), written from real project work.
 * Each item was checked against the Construct 3 manual (r495), real
 * editor-saved projects, or the runtime code exported games ship with
 * ([runtime]); claims only c3-skill supports are tagged [practice].
 */

export const PITFALLS_URI = 'construct3://docs/pitfalls';

const MANUAL = 'https://www.construct.net/en/make-games/manuals/construct-3';

export const PITFALLS_MARKDOWN = `# Construct 3 pitfalls

Behaviors that load fine in the editor but break game logic quietly. Sources:
**[manual]** = stated in the Construct 3 manual, **[projects]** = visible in
editor-saved projects, **[runtime]** = read in the runtime code that exported
Construct 3 games ship with, **[practice]** = reported from real project work
in komabear/c3-skill (MIT) and not confirmed by the manual, so check it in
your own project.

Run the \`find_runtime_traps\` tool to detect items 7 and 8 automatically.
\`validate_project\` reports items 1 and 2 (checks \`expression-syntax\` and
\`empty-expression\`), and the event sheet tools refuse writes that add them.

## Expressions and event JSON

### 1. No backslash escapes in expression strings
A string in an expression is text in double quotes. To put a double quote
inside it, write two: \`"He said ""hi"" to me"\` [manual: Expressions].
Backslash is not an escape character. Writing \`\\"\` inside an expression is
reported to stop the sheet loading with \`Syntax error: Unknown character\`
[practice]. In event JSON the expression is itself a JSON string, so the C3
literal \`"hit"\` is stored as \`"\\"hit\\""\`.

### 2. Expression parameters are never empty
Editor-saved sheets store an empty text parameter as the quoted empty literal,
e.g. \`"tag-optional": "\\"\\""\` [projects]. A truly empty JSON value (\`""\`)
is reported to make the editor reject the project with
\`Empty expression: You must enter an expression\` [practice].

### 3. Dictionary.Get on a missing key returns 0
\`Dictionary.Get(key)\` returns 0 when the key does not exist [manual: Dictionary].
When a key may be missing (old saves, optional data, values fed into text or
JSON parsing), use \`Dictionary.GetDefault(key, valueIfMissing)\` instead.

### 4. int("") is 0 and int("0.20") is 0
\`int(x)\` converts to a whole number. For text it reads the number at the
start and ignores what follows; text that does not start with a number gives 0
(\`int("xx33")\` = 0) [manual: System expressions]. So an empty or missing value
reads as a real-looking 0, and decimal text loses its fraction. Use \`float()\`
for decimal text, and keep numbers in number variables instead of re-parsing
displayed text.

## Picking and animation

### 5. Compare two values does not pick instances
Most system conditions pick nothing; they are just true or false
[manual: How events work]. *Compare two values* stays a plain value comparison
even when an expression mentions an object, e.g. \`Badge.id = 3\` (the editor's
own description: "This condition does not pick any objects"). The actions that
follow run on whatever the rest of the event picked, and with no picking that
is every instance [manual: How events work]. To act on one instance, use an
object condition such as *Compare instance variable*, or a *For each* loop.

### 6. Setting the animation that is already playing does not restart it
*Set animation* does nothing if that animation is already playing, even when
set to play from the beginning [manual: Sprite]. To restart it, use the *Start*
action and choose "from beginning". Logic waiting on that animation's frame
tags will keep waiting [practice].

## Signals and scripts

### 7. Signals are not queued
*Signal* resumes events paused in *Wait for signal* with that tag; *Wait for
signal* waits indefinitely until a *Signal* with the same tag runs
[manual: System actions]. *Signal* only resumes the waits that already exist
when it runs, and every *Wait for signal* (or \`runtime.waitForSignal()\`)
starts a fresh wait, so a signal that fires before the wait starts is dropped
and the later wait can hang [runtime; practice: c3-skill]. This is a common
cause of soft-locks such as frozen animations or turns that never end
[practice]. *On signal* matches tags case-insensitively
[manual: System conditions]. Scripts use \`runtime.signal(tag)\` and
\`await runtime.waitForSignal(tag)\` [manual: IRuntime].

A *Wait* defers only the rest of its own event (its remaining actions and
sub-events); the events after it still run in the same tick [runtime]. So a
signal raised inside a called function reaches a *Wait for signal* that the
caller starts after the call only when the function reaches a *Wait* before
that *Signal* (the call returns at the *Wait*), or when a later *Signal* with
the same tag wakes the wait. A function whose last sub-event raises the
*Signal*, after sub-events that wait, raises it during the call.

Fix: raise the *Signal* after the work it announces is done, or latch it.
Set a flag or counter where the signal fires and check it before waiting, or
re-signal until the waiter has consumed it. Each waiter must consume the latch
exactly once, right after its wait, and the latch is reset when the flow
(turn, attack, round) restarts: a replay that re-signals while the latch is
set wakes every wait on that tag, so a stale latch resumes a later, unrelated
wait early. Before changing a flow that already works in-game, confirm the
race there; a later *Signal* with the same tag may be what completes it.
\`find_runtime_traps\` reports waits whose tag is never signalled anywhere, and
waits that start after a call or an earlier action already raised their tag.

### 8. Scripts cannot see function parameters as variables
In script actions and script blocks, event local variables and function
parameters are only reachable through \`localVars\` (\`localVars.mode\`, or
\`localVars["my var"]\`); global variables are on \`runtime.globalVars\`
[manual: Scripts in event sheets]. A bare \`mode\` throws \`ReferenceError\`.
The engine catches script exceptions and logs them to the console instead of
crashing the game [manual], but the remaining actions of that event are
reported not to run, so a feature silently stops with a single console line
[practice]. \`find_runtime_traps\` reports these.

### 9. Never compare window or viewport sizes for exact equality [practice]
A branch like \`ViewportHeight(layer) = ViewportWidth(layer)\` ("square
screen") almost never matches a real window, and near-square windows fall
arbitrarily into another branch. Compare with a tolerance, e.g.
\`abs(h - w) <= tolerance * min(h, w)\`, make the branches cover every case
(landscape, square, portrait), and keep the tolerance in one global variable.

## Sources
- Manual: [Expressions](${MANUAL}/project-primitives/events/expressions),
  [How events work](${MANUAL}/project-primitives/events/how-events-work),
  [System actions](${MANUAL}/system-reference/system-actions),
  [System conditions](${MANUAL}/system-reference/system-conditions),
  [System expressions](${MANUAL}/system-reference/system-expressions),
  [Dictionary](${MANUAL}/plugin-reference/dictionary),
  [Sprite](${MANUAL}/plugin-reference/sprite),
  [Scripts in event sheets](${MANUAL}/scripting/using-scripting/scripts-in-event-sheets),
  [IRuntime](${MANUAL}/scripting/scripting-reference/iruntime)
- Practice: [komabear/c3-skill](https://github.com/komabear/c3-skill) (MIT)
`;
