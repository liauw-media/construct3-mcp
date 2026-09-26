/**
 * Unit tests for the script scanner used by the runtime-trap analyzer.
 */

import { describe, it, expect } from 'vitest';
import {
  getScriptSource,
  tokenizeScript,
  collectDeclaredNames,
  findBareIdentifierUses,
  findScriptSignalCalls,
  findScriptFunctionCalls,
  collectImportsForEventsNames,
} from '../../src/construct3/analyzers/script-scan.js';

function usedNames(source: string, names: string[], typescript = false): string[] {
  return findBareIdentifierUses(source, names, { typescript }).map(u => u.name);
}

describe('getScriptSource', () => {
  it('accepts a single string (this server\'s writer, older saves)', () => {
    expect(getScriptSource('a();\nb();')).toBe('a();\nb();');
  });

  it('accepts an array of lines (current C3 saves)', () => {
    expect(getScriptSource(['a();', 'b();'])).toBe('a();\nb();');
  });

  it('returns null for missing or unexpected values', () => {
    expect(getScriptSource(undefined)).toBeNull();
    expect(getScriptSource(42)).toBeNull();
  });
});

describe('tokenizeScript', () => {
  it('drops comments and turns literals into single tokens', () => {
    const tokens = tokenizeScript('// mode\n/* mode */ const s = "mode"; const r = /mode/g;');
    const idents = tokens.filter(t => t.kind === 'ident').map(t => t.value);
    expect(idents).toEqual(['const', 's', 'const', 'r']);
    expect(tokens.find(t => t.kind === 'string')?.value).toBe('mode');
  });

  it('tokenizes template substitutions as code but not template text', () => {
    const tokens = tokenizeScript('const t = `mode ${ mode + 1 } ${ {a: 1}.a } end`;');
    const idents = tokens.filter(t => t.kind === 'ident').map(t => t.value);
    expect(idents).toEqual(['const', 't', 'mode', 'a', 'a']);
  });

  it('decodes escapes in string literals', () => {
    const tokens = tokenizeScript('f("a\\"b", \'c\\nd\')');
    const strings = tokens.filter(t => t.kind === 'string').map(t => t.value);
    expect(strings).toEqual(['a"b', 'c\nd']);
  });

  it('tracks line numbers across lines and block comments', () => {
    const tokens = tokenizeScript('a;\n/* x\n y */\nb;');
    expect(tokens.find(t => t.value === 'b')?.line).toBe(4);
  });

  it('treats a slash after a value as division', () => {
    const tokens = tokenizeScript('const x = (a) / mode / 2;');
    expect(tokens.filter(t => t.kind === 'ident').map(t => t.value)).toContain('mode');
  });

  it('treats a slash after postfix ++/-- as division', () => {
    const idents = (src: string) => tokenizeScript(src).filter(t => t.kind === 'ident').map(t => t.value);
    expect(idents('const y = i++ / mode / 2;')).toContain('mode');
    expect(idents('const y = i-- / mode / 2;')).toContain('mode');
  });

  it('reads a regex after an if/while/for header and after a template ${', () => {
    const idents = (src: string) => tokenizeScript(src).filter(t => t.kind === 'ident').map(t => t.value);
    expect(idents('if (s) /mode/.test(s);')).not.toContain('mode');
    expect(idents('while (x) /mode/g.exec(s);')).not.toContain('mode');
    expect(idents('const t = `a${/mode/.test(s)}b${/mode/.test(s)}`;')).not.toContain('mode');
    expect(idents('const t = `a${x}` / mode;')).toContain('mode');
  });

  it('does not treat non-breaking or line-separator spaces as identifier characters', () => {
    const tokens = tokenizeScript('log(mode );\nlog(mode );\nlog(modé);');
    const idents = tokens.filter(t => t.kind === 'ident').map(t => t.value);
    expect(idents).toEqual(['log', 'mode', 'log', 'mode', 'log', 'modé']);
  });
});

describe('collectDeclaredNames', () => {
  it('collects let/const/var including lists and destructuring', () => {
    const names = collectDeclaredNames(tokenizeScript('let a = 1, b = f(x, y);\nconst { c, d: e } = o;\nvar [g, h] = arr;'));
    for (const n of ['a', 'b', 'c', 'd', 'e', 'g', 'h']) expect(names.has(n)).toBe(true);
    expect(names.has('x')).toBe(false);
    expect(names.has('y')).toBe(false);
  });

  it('stops a declaration at the end of the line', () => {
    const names = collectDeclaredNames(tokenizeScript('const a = 1\nlog(mode, other)'));
    expect(names.has('a')).toBe(true);
    expect(names.has('mode')).toBe(false);
    expect(names.has('other')).toBe(false);
  });

  it('collects function, arrow, catch and method parameters', () => {
    const src = [
      'function f(p1, p2 = mode) {}',
      'const g = (p3, { p4 }) => p3;',
      'const h = p5 => p5;',
      'const k = (p6: string, p7?: number): Result => p6;',
      'try { x(); } catch (err) {}',
      'const o = { m(p8) { return p8; } };',
    ].join('\n');
    const names = collectDeclaredNames(tokenizeScript(src));
    for (const n of ['f', 'p1', 'p2', 'g', 'p3', 'p4', 'h', 'p5', 'k', 'p6', 'p7', 'err', 'p8']) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has('mode')).toBe(false); // default value, not a binding
    expect(names.has('Result')).toBe(false); // return type, not a parameter
  });

  it('declares an unparenthesized arrow parameter after a colon', () => {
    const src = [
      'tween.start({ onDone: value => runtime.globalVars.v = value });',
      'const f = flag ? g() : other => other * 2;',
      'const h = async (p9): Promise<void> => {};',
    ].join('\n');
    const names = collectDeclaredNames(tokenizeScript(src));
    for (const n of ['value', 'other', 'p9']) expect(names.has(n)).toBe(true);
  });

  it('does not treat if/for/while conditions as parameter lists', () => {
    const names = collectDeclaredNames(tokenizeScript('if (mode) { a(); }\nwhile (mode) { b(); }\nfor (let i = 0; i < mode; i++) {}'));
    expect(names.has('mode')).toBe(false);
    expect(names.has('i')).toBe(true);
  });
});

describe('findBareIdentifierUses', () => {
  it('flags a parameter used as a bare identifier', () => {
    const uses = findBareIdentifierUses('console.log("mode is", mode);', ['mode']);
    expect(uses).toEqual([{ name: 'mode', lines: [1] }]);
  });

  it('reports every line a name is used on', () => {
    const uses = findBareIdentifierUses('a(mode);\nb();\nc(mode, mode);', ['mode']);
    expect(uses[0].lines).toEqual([1, 3]);
  });

  it('ignores localVars and other property accesses', () => {
    expect(usedNames('const m = localVars.mode; obj.mode = 1; obj?.mode; runtime.globalVars.mode;', ['mode'])).toEqual([]);
  });

  it('ignores string contents, template text and comments', () => {
    const src = [
      'console.log("mode");',
      "console.log('mode');",
      'console.log(`mode is fixed`);',
      '// mode',
      '/* mode */',
    ].join('\n');
    expect(usedNames(src, ['mode'])).toEqual([]);
  });

  it('flags a parameter inside a template substitution', () => {
    expect(usedNames('console.log(`mode is ${mode}`);', ['mode'])).toEqual(['mode']);
  });

  it('ignores names the script declares itself', () => {
    expect(usedNames('let mode = localVars.mode;\nconsole.log(mode);', ['mode'])).toEqual([]);
    expect(usedNames('const f = (mode) => mode * 2;', ['mode'])).toEqual([]);
    expect(usedNames('function f(mode) { return mode; }', ['mode'])).toEqual([]);
  });

  it('ignores a method definition that shares the name but flags calls', () => {
    expect(usedNames('const o = { mode(x) { return x; } };', ['mode'])).toEqual([]);
    expect(usedNames('mode(1);', ['mode'])).toEqual(['mode']);
  });

  it('ignores object keys but flags shorthand properties', () => {
    expect(usedNames('const o = { mode: 1, other: 2 };', ['mode'])).toEqual([]);
    expect(usedNames('const o = { mode };', ['mode'])).toEqual(['mode']);
  });

  it('flags ternary branches and computed access', () => {
    expect(usedNames('const x = flag ? mode : 0;', ['mode'])).toEqual(['mode']);
    expect(usedNames('const x = table[mode];', ['mode'])).toEqual(['mode']);
  });

  it('ignores typeof (safe on undeclared names)', () => {
    expect(usedNames('if (typeof mode === "undefined") {}', ['mode'])).toEqual([]);
  });

  it('ignores regex literal contents', () => {
    expect(usedNames('const ok = /mode/.test(s);', ['mode'])).toEqual([]);
  });

  it('never flags reserved words or the script globals Construct provides', () => {
    expect(usedNames('runtime.callFunction("x"); localVars.a; default_;', ['runtime', 'localVars', 'default'])).toEqual([]);
  });

  it('handles TypeScript declarations that reuse parameter names', () => {
    const src = [
      'type DataType = readonly string[] | Record<string, string>;',
      'const get = (listType: string, index?: string): DataType => {',
      '  if (!index) return [];',
      '  return index.split("-");',
      '};',
      'const data: DataType = get(localVars.type, localVars.index);',
    ].join('\n');
    expect(usedNames(src, ['type', 'index'], true)).toEqual([]);
  });

  it('skips TypeScript type keywords used as parameter names in TypeScript scripts', () => {
    expect(usedNames('let a: string = "x";', ['string'], true)).toEqual([]);
  });

  it('ignores arrow parameters in object values and ternaries', () => {
    expect(usedNames('tween.start({ onDone: value => runtime.globalVars.v = value });', ['value'])).toEqual([]);
    expect(usedNames('const handlers = {\n  ok: result => console.log(result),\n};', ['result'])).toEqual([]);
    expect(usedNames('const f = flag ? null : value => value * 2;', ['value'])).toEqual([]);
  });

  it('ignores members of TypeScript interfaces, type aliases and type literals', () => {
    const cases = [
      'type Opts = { id: string; mode: number };\nconst o: Opts = { id: "a", mode: localVars.mode };',
      'interface Opts { mode?: number }\nconst o: Opts = {};',
      'interface P {\n  id: number\n  mode: number\n}',
      'interface I { mode(): void; }',
      'type Handler = (mode: number) => void;',
      'type M = mode;',
      'let o: { id: string; mode: number } = { id: "", mode: 0 };',
      'let o: {\n  id: string\n  mode?: number\n} = { id: "" };',
    ];
    for (const src of cases) expect(usedNames(src, ['mode'], true)).toEqual([]);
  });

  it('ignores class fields, enum members, #private names and labels', () => {
    const cases: Array<[string, boolean]> = [
      ['class A { x = 1; mode = 2; }', false],
      ['class A {\n  mode = 2;\n}\nnew A();', false],
      ['class A { mode: string = "a"; static mode2 = 1; }', true],
      ['class A { static mode = 1; readonly other = 2 }', true],
      ['class A { mode; constructor(s) { this.mode = s; } }', false],
      ['class A { #mode = 1; get() { return this.#mode; } }', false],
      ['enum E { a = 1, mode = 2 }', true],
      ['const enum E {\n  mode,\n  other\n}', true],
      ['mode: for (const i of [1]) { break mode; }', false],
      ['a();\nmode: for (;;) { continue mode; }', false],
    ];
    for (const [src, ts] of cases) expect(usedNames(src, ['mode'], ts)).toEqual([]);
  });

  it('still flags value uses next to those constructs', () => {
    const cases: Array<[string, boolean]> = [
      ['class A { speed = mode; }', false],
      ['class A { go() { return mode; } }', false],
      ['class A {\n  go() {\n    mode = 1;\n  }\n}', false],
      ['enum E { a = mode }', true],
      ['switch (x) { case mode: break; }', false],
      ['const x = flag\n  ? mode\n  : 0;', false],
      ['interface P { a: number }\nlog(mode);', true],
      ['type T = string;\nlog(mode);', true],
      ['type T = string\nconst y = mode;', true],
      ['if (s) /x/.test(s); log(mode);', false],
      ['let i = 0; const y = i++ / mode / 2;', false],
    ];
    for (const [src, ts] of cases) expect(usedNames(src, ['mode'], ts)).toEqual(['mode']);
  });

  it('skips names passed as globals (e.g. from the Imports for events script)', () => {
    expect(findBareIdentifierUses('Utils.run(mode);', ['Utils', 'mode'], { globals: ['Utils'] })).toEqual([
      { name: 'mode', lines: [1] },
    ]);
  });

  it('limits a parameter of the script\'s own function to that function', () => {
    const cases: Array<[string, number[]]> = [
      ['function helper(mode) { return mode; }\nconsole.log(mode);', [2]],
      ['const f = (mode) => mode;\nconsole.log(mode);', [2]],
      ['function apply(mode){ return mode; }\napply(mode);', [2]],
      ['const f = mode => mode * 2\nlog(mode)', [2]],
      ['try {} catch (mode) {}\nlog(mode)', [2]],
      ['const o = { m(mode) { return mode; } };\nlog(mode);', [2]],
      ['tween.start({ onDone: mode => mode, other: mode });', [1]],
    ];
    for (const [src, lines] of cases) expect(findBareIdentifierUses(src, ['mode'])).toEqual([{ name: 'mode', lines }]);
  });

  it('still hides a parameter inside its own function', () => {
    expect(usedNames('[1].map(mode => mode * 2)', ['mode'])).toEqual([]);
    expect(usedNames('const f = function (mode) {\n  return mode;\n};', ['mode'])).toEqual([]);
    expect(usedNames('function f(a, mode = 1) {\n  if (a) {\n    return mode;\n  }\n}', ['mode'])).toEqual([]);
  });

  it('keeps let/const/var declarations script-wide', () => {
    expect(usedNames('log(mode);\nlet mode = 1;', ['mode'])).toEqual([]);
    expect(usedNames('function f() { let mode = 1; }\nlog(mode);', ['mode'])).toEqual([]);
  });

  it('limits parameters of TypeScript functions and methods with return types or type parameters', () => {
    const cases: Array<[string, number[]]> = [
      ['class A {\n  go(mode: number): void {\n    log(mode);\n  }\n}\nlog(mode);', [6]],
      ['function f<T>(mode: T): T { return mode; }\nlog(mode);', [2]],
      ['function f(mode): { a: number } { return { a: mode }; }\nlog(mode);', [2]],
      ['const f = async (mode): Promise<void> => { await mode; };\nlog(mode);', [2]],
    ];
    for (const [src, lines] of cases) {
      expect(findBareIdentifierUses(src, ['mode'], { typescript: true })).toEqual([{ name: 'mode', lines }]);
    }
  });

  it('ignores TypeScript annotations, return types, as/satisfies types and type arguments', () => {
    const cases = [
      'const m: { [key: string]: number } = {};',
      'function f(): { [key: string]: number } { return {}; }',
      'const m = o as { [key: string]: number };',
      'let y: key = 1;',
      'let y: key[] = [];',
      'new Map<key, number>();',
      'const r: Record<string, key> = {}, s: key | null = null;',
      'let y!: key;',
      'const f = (a): key => a;',
      'const v = o satisfies Record<string, key>;',
      'const c = { go(): key { return 1; } };',
    ];
    for (const src of cases) expect(usedNames(src, ['key'], true)).toEqual([]);
  });

  it('ignores an index signature key in a script not marked as TypeScript', () => {
    expect(usedNames('const m = o as { [key: string]: number };', ['key'])).toEqual([]);
  });

  it('still flags values next to TypeScript types', () => {
    const cases = [
      'const obj = { [key]: 1 };',
      'if (a < key) {}',
      'const v = c ? key : d;',
      'let y = key;',
      'let a: number = key;',
      'let y: Foo\nlog(key);',
      'const y = o as Foo\nlog(key);',
      'const y = (o as Foo) || key;',
      'const v = c ? f(x) : key;',
      'const v = c ? (x) : key;',
      'switch (v) { case f(x): log(key); }',
      'const x = a < key, y = b > (c);',
      'const f = (a: number): number => a + key;',
      'const c = { go(): number { return key; } };',
    ];
    for (const src of cases) expect(usedNames(src, ['key'], true)).toEqual(['key']);
  });
});

describe('collectImportsForEventsNames', () => {
  it('collects import bindings and top-level declarations', () => {
    const names = collectImportsForEventsNames([
      '// Put imports here that you wish to use for script blocks in event sheets',
      'import * as Globals from "./globals.js";',
      'import Default, { a, b as c } from "./x.js";',
      'import "./side-effect.js";',
      'export const configureApi = API.configureApi;',
      'function helper() {}',
    ].join('\n'));
    for (const n of ['Globals', 'Default', 'a', 'b', 'c', 'configureApi', 'helper']) expect(names.has(n)).toBe(true);
    expect(names.has('from')).toBe(false);
    expect(names.has('API')).toBe(false);
  });
});

describe('findScriptSignalCalls', () => {
  it('finds literal runtime.signal and runtime.waitForSignal calls', () => {
    const calls = findScriptSignalCalls('runtime.signal("hit");\nawait runtime.waitForSignal(\'done\');');
    expect(calls).toEqual([
      { method: 'signal', tag: 'hit', line: 1 },
      { method: 'waitForSignal', tag: 'done', line: 2 },
    ]);
  });

  it('reports non-literal tags as null', () => {
    const calls = findScriptSignalCalls('runtime.signal("step" + n); runtime.signal(tag);');
    expect(calls.map(c => c.tag)).toEqual([null, null]);
  });

  it('records the literal prefix of a "prefix" + x tag', () => {
    const calls = findScriptSignalCalls([
      'runtime.signal("step" + n);',
      'runtime.signal(n + "step");',
      'runtime.signal("a" + (x ? "b" : "c"));',
      'runtime.signal("a" + b, 1);',
    ].join('\n'));
    expect(calls.map(c => c.prefix)).toEqual(['step', undefined, undefined, undefined]);
  });

  it('ignores commented-out calls', () => {
    expect(findScriptSignalCalls('// runtime.signal("hit");\n/* runtime.signal("x") */')).toEqual([]);
  });

  it('counts calls through x.runtime (IInstance.runtime and IBehaviorInstance.runtime are the IRuntime)', () => {
    expect(findScriptSignalCalls('inst.runtime.signal("hit");\nawait this.runtime.waitForSignal("done");')).toEqual([
      { method: 'signal', tag: 'hit', line: 1 },
      { method: 'waitForSignal', tag: 'done', line: 2 },
    ]);
  });

  it('counts calls through a local alias of the runtime and computed method names', () => {
    const calls = findScriptSignalCalls([
      'const r = runtime;',
      'r.signal("a");',
      'runtime["signal"]("b");',
      "const rt: IRuntime = this.runtime; await rt['waitForSignal']('c');",
    ].join('\n'));
    expect(calls).toEqual([
      { method: 'signal', tag: 'a', line: 2 },
      { method: 'signal', tag: 'b', line: 3 },
      { method: 'waitForSignal', tag: 'c', line: 4 },
    ]);
  });

  it('ignores per-instance signals and other objects', () => {
    const src = 'inst.signal("a");\nawait inst.waitForSignal("b");\nconst q = runtime.objects;\nq.signal("c");\nconst r = runtime;\nx.r.signal("d");';
    expect(findScriptSignalCalls(src)).toEqual([]);
  });
});

describe('findScriptFunctionCalls', () => {
  it('captures the function name and literal arguments', () => {
    const calls = findScriptFunctionCalls('runtime.callFunction("Emit", "hit", f(a, b), 3);');
    expect(calls).toEqual([{ name: 'Emit', args: ['hit', null, null], line: 1 }]);
  });

  it('handles calls without arguments', () => {
    expect(findScriptFunctionCalls('runtime.callFunction("Reset");')).toEqual([{ name: 'Reset', args: [], line: 1 }]);
  });

  it('finds calls through x.runtime, a local alias and a computed method name', () => {
    const src = 'inst.runtime.callFunction("F", "a");\nconst r = runtime;\nr.callFunction("G");\nruntime["callFunction"]("H", 1);';
    expect(findScriptFunctionCalls(src)).toEqual([
      { name: 'F', args: ['a'], line: 1 },
      { name: 'G', args: [], line: 3 },
      { name: 'H', args: [null], line: 4 },
    ]);
  });
});
