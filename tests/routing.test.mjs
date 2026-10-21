import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AudioRouting } from '../main/routing.mjs';

test('startup reset replaces stale modules even without a ledger and keeps unrelated devices', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-reset-'));
  let index = 100;
  const modules = [{ index: 42, name: 'module-null-sink', argument: 'sink_name=someone_else' }];
  const calls = [];
  const run = async (_command, args) => {
    calls.push([...args]);
    if (args.join(' ') === 'list short modules') return { stdout: modules.map(m => `${m.index}\t${m.name}\t${m.argument}`).join('\n') };
    if (args[0] === 'load-module') { const item = { index: ++index, name: args[1], argument: args.slice(2).join(' ') }; modules.push(item); return { stdout: String(index) }; }
    if (args[0] === 'unload-module') { modules.splice(modules.findIndex(m => m.index === Number(args[1])), 1); return { stdout: '' }; }
    throw Error('Unexpected command');
  };
  const routing = new AudioRouting(directory, { platform: 'linux', run });
  routing.status = async () => ({ ready: modules.length === 5, managed: true });
  try {
    await routing.setup(); const before = modules.filter(m => m.index !== 42).map(m => m.index);
    // Simulate a lost/corrupt ownership record from an interrupted run.
    await writeFile(path.join(directory, 'routing.json'), 'broken record');
    calls.length = 0;
    await routing.reset();
    const after = modules.filter(m => m.index !== 42).map(m => m.index);
    assert.equal(after.length, 4); assert.ok(after.every(id => !before.includes(id)));
    assert.equal(calls.filter(args => args[0] === 'unload-module').length, 4);
    assert.equal(modules.some(m => m.index === 42), true);
    await routing.remove();
    assert.deepEqual(modules.map(m => m.index), [42]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
