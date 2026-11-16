// Unit tests for the multi-execute routing and the keyboard helpers.
import assert from 'node:assert';
import { createInputBus, isPasteShortcut, scancodeFor } from '../src/inputBus.mjs';
import { readFileSync } from 'node:fs';
// scancodes.js is ESM syntax inside a CommonJS-typed package (Vite handles that); load it as a module here.
const { SCANCODES } = await import('data:text/javascript;base64,' + readFileSync(new URL('../src/rdp/scancodes.js', import.meta.url)).toString('base64'));

let state = { on: true, keys: ['a', 'b', 'c'] };
const bus = createInputBus(() => state);
const got = { a: [], b: [], c: [], d: [] };
for (const k of ['a', 'b', 'c', 'd']) bus.register(k, (e) => got[k].push(e));

// events from a reach b and c, never back to a
bus.emit('a', { kind: 'text', data: 'ls\r' });
assert.deepStrictEqual(got.a, []);
assert.deepStrictEqual(got.b, [{ kind: 'text', data: 'ls\r' }]);
assert.deepStrictEqual(got.c, [{ kind: 'text', data: 'ls\r' }]);
assert.deepStrictEqual(got.d, [], 'd is not a participant');
assert.deepStrictEqual(bus.targets('a'), ['b', 'c']);

// off: nothing is delivered
state = { on: false, keys: ['a', 'b', 'c'] };
bus.emit('a', { kind: 'text', data: 'x' });
assert.strictEqual(got.b.length, 1);

// a source that is not a participant sends nothing (excluded pane)
state = { on: true, keys: ['b', 'c'] };
bus.emit('a', { kind: 'text', data: 'x' });
assert.strictEqual(got.b.length, 1);
assert.strictEqual(got.c.length, 1);
// ...and a non-participant never receives
bus.emit('b', { kind: 'text', data: 'y' });
assert.strictEqual(got.a.length, 0);
assert.strictEqual(got.c.length, 2);

// a throwing receiver does not stop the rest
state = { on: true, keys: ['a', 'b', 'c'] };
bus.register('b', () => { throw new Error('boom'); });
bus.emit('a', { kind: 'key', down: true, sc: 0x1e });
assert.deepStrictEqual(got.c.at(-1), { kind: 'key', down: true, sc: 0x1e });

// unregister
const off = bus.register('c', (e) => got.c.push(e));
off();
const n = got.c.length;
bus.emit('a', { kind: 'text', data: 'z' });
assert.strictEqual(got.c.length, n);
// a stale unregister (older handler) must not remove a newer registration
const h1 = () => {}; const h2 = (e) => got.d.push(e);
const off1 = bus.register('d', h1); bus.register('d', h2); off1();
state = { on: true, keys: ['a', 'd'] };
bus.emit('a', { kind: 'text', data: 'q' });
assert.strictEqual(got.d.length, 1);

// paste shortcuts
assert.ok(isPasteShortcut({ ctrlKey: true, code: 'KeyV' }));
assert.ok(isPasteShortcut({ metaKey: true, code: 'KeyV' }));
assert.ok(isPasteShortcut({ shiftKey: true, code: 'Insert' }));
assert.ok(!isPasteShortcut({ code: 'KeyV' }));
assert.ok(!isPasteShortcut({ ctrlKey: true, code: 'KeyC' }));

// Mac: Cmd acts as Ctrl; everywhere else the Windows key stays the Windows key
assert.strictEqual(scancodeFor('MetaLeft', SCANCODES, true), SCANCODES.ControlLeft);
assert.strictEqual(scancodeFor('MetaRight', SCANCODES, true), SCANCODES.ControlLeft);
assert.strictEqual(scancodeFor('MetaLeft', SCANCODES, false), SCANCODES.MetaLeft);
assert.strictEqual(scancodeFor('KeyV', SCANCODES, true), SCANCODES.KeyV);
assert.strictEqual(scancodeFor('Nope', SCANCODES, true), undefined);

console.log('Input bus tests passed');
