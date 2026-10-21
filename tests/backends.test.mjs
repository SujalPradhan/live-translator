import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioBackends, probeBackend } from '../main/backends.mjs';
import { pipewireInventory } from '../main/pipewire.mjs';

const missingPactl = async (command, args) => {
  if (command === 'pactl') throw Object.assign(Error('not found'), { code: 'ENOENT' });
  return { stdout: command === 'pw-dump' ? '[]' : 'available' };
};
test('missing pactl is actionable and does not block native PipeWire dependencies', async () => {
  const pulse = await probeBackend('pulse', { platform: 'linux', run: missingPactl });
  assert.equal(pulse.available, false); assert.match(pulse.checks[0].detail, /pactl is not installed/);
  const native = await probeBackend('pipewire', { platform: 'linux', run: missingPactl });
  assert.equal(native.available, true);
  const wpctlOnly = await probeBackend('pipewire', { platform: 'linux', run: async command => {
    if (command !== 'wpctl') throw Object.assign(Error('missing'), { code: 'ENOENT' });
    return { stdout: 'PipeWire' };
  } });
  assert.equal(wpctlOnly.available, false); assert.match(wpctlOnly.guidance.join(' '), /cannot create/);
});
test('auto falls back after absent pactl and after failed module creation', async () => {
  for (const absent of [true, false]) {
    const calls = [];
    const fake = id => ({ reset: async () => { calls.push(id); if (id === 'pulse') throw Error('module denied'); return { ready: true }; },
      remove: async () => {}, status: async () => ({ ready: true }), watch: () => () => {} });
    const run = absent ? missingPactl : async (_command, args) => ({ stdout: args.includes('json') || args.includes('-N') ? '[]' : 'available' });
    const routing = new AudioBackends('/unused', { platform: 'linux', run, pulse: fake('pulse'), pipewire: fake('pipewire') });
    const result = await routing.reset(); assert.equal(result.activeBackend, 'pipewire');
    assert.deepEqual(calls, absent ? ['pipewire'] : ['pulse', 'pipewire']);
    assert.equal((await routing.status()).activeBackend, 'pipewire'); await routing.remove();
  }
});
test('unavailable manual selection preserves the current backend', async () => {
  let removed = false;
  const routing = new AudioBackends('/unused', { platform: 'linux', run: missingPactl, pipewire: { remove: async () => { removed = true; } } });
  routing.active = 'pipewire';
  await assert.rejects(routing.select('pulse'), /pactl is not installed/);
  assert.equal(routing.active, 'pipewire'); assert.equal(removed, false);
  await assert.rejects(routing.probe('arbitrary-command'), /specific audio backend/);
});
test('macOS and Windows choose external mappings without running Linux commands', async () => {
  for (const platform of ['darwin', 'win32']) {
    const run = async () => { throw Error('No Linux commands permitted'); };
    const routing = new AudioBackends('/unused', { platform, run });
    assert.equal((await routing.reset()).activeBackend, 'external');
    assert.equal((await routing.status()).managed, false);
    assert.equal((await routing.probe('pipewire')).available, false);
    assert.equal((await routing.probe('external')).available, true);
    await routing.remove();
  }
});
test('native PipeWire inventory uses metadata defaults and rejects virtual devices as physical', () => {
  const objects = [{ type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [{ key: 'default.audio.sink', value: '{"name":"headset"}' }] },
    ...[['headset', 'Audio/Sink', false], ['cable', 'Audio/Source', true]].map(([name, kind, virtual]) => ({ type: 'PipeWire:Interface:Node', info: { props: {
      'node.name': name, 'node.description': name, 'media.class': kind, 'node.virtual': virtual, 'device.id': 12
    } } }))];
  const devices = pipewireInventory(objects); assert.equal(devices[0].isDefault, true); assert.equal(devices[0].isVirtual, false); assert.equal(devices[1].isVirtual, true);
});

test('a failed manual routing test restores the previous working backend', async () => {
  let restored = 0;
  const run = async (_command, args) => ({ stdout: args.includes('json') || args.includes('-N') ? '[]' : 'available' });
  const routing = new AudioBackends('/unused', { platform: 'linux', run,
    pulse: { remove: async () => {}, reset: async () => { throw Error('module creation denied'); } },
    pipewire: { remove: async () => {}, reset: async () => { restored++; return { ready: true }; }, watch: () => () => {} } });
  routing.active = 'pipewire';
  await assert.rejects(routing.select('pulse'), /previous audio backend was restored/);
  assert.equal(routing.active, 'pipewire'); assert.equal(restored, 1);
});
