import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, translationSetup, validateSettings } from '../shared/settings.js';
import { Resampler, playbackPlan } from '../renderer/pcm.js';
import { chooseDevice, deviceLists, virtualEndpoints } from '../renderer/devices.js';
import { SettingsStore } from '../main/store.mjs';
import { AudioRouting, endpointLabels } from '../main/routing.mjs';
import { AudioRoute } from '../renderer/route.js';

test('closing and restarting routing is safe after its AudioContext has been disposed', async () => {
  const route = new AudioRoute('voice', { stopTranslation: async () => {} }, () => {});
  route.original = { gain: { setValueAtTime: () => {} }, disconnect: () => {} };
  route.context = { state: 'running', currentTime: 1, close: async () => {} };
  await route.close();
  assert.equal(route.ready, false);
  await route.close();
  route.stop();
  assert.equal(route.phase, 'normal');
});

test('resampling preserves frame timing and little-endian PCM across irregular blocks', () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    const resampler = new Resampler(rate, 640); const frames = [];
    for (let offset = 0; offset < rate; offset += 127)
      frames.push(...resampler.push(new Float32Array(Math.min(127, rate - offset)).fill(0.5)));
    assert.equal(frames.length, 25);
    assert.equal(frames[0].byteLength, 1280);
    assert.equal(new DataView(frames[0]).getInt16(0, true), 16384);
  }
});

test('queue overload clears delayed speech and bounds oversized responses', () => {
  const normal = playbackPlan(10, 10.2, 0.1, 60, 1500);
  assert.equal(normal.overflow, false); assert.ok(Math.abs(normal.end - 10.3) < 1e-9);
  const overflow = playbackPlan(10, 11.4, 0.5, 60, 1500);
  assert.equal(overflow.overflow, true); assert.ok(overflow.end <= 11.5);
  const oversized = playbackPlan(10, 0, 30, 60, 1500);
  assert.ok(oversized.offset > 28); assert.ok(oversized.end <= 11.50001);
});

test('settings preserve explicit defaults, independent targets and bounded tuning', () => {
  assert.deepEqual(validateSettings(defaults), defaults);
  assert.equal(translationSetup(defaults, 'hi').setup.generationConfig.translationConfig.echoTargetLanguage, true);
  assert.equal(validateSettings({ ...defaults, voiceTarget: 'en' }).listenTarget, 'hi');
  assert.throws(() => validateSettings({ ...defaults, chunkMs: 0 }));
  assert.throws(() => validateSettings({ ...defaults, baseUrl: 'https://example.com/key' }));
  assert.throws(() => validateSettings({ ...defaults, maxBufferMs: 200, playbackBufferMs: 180 }));
  assert.ok(!Object.hasOwn(validateSettings({ ...defaults, key: 'secret' }), 'key'));
});

const device = (deviceId, label, kind, groupId = '') => ({ deviceId, label, kind, groupId });
test('virtual defaults are excluded; physical pairing uses group IDs, missing explicit devices fail safely', () => {
  const devices = [
    device('default', 'Default - GeminiSpeaker', 'audiooutput'),
    device('v', 'GeminiSpeaker', 'audiooutput'),
    device('mic', 'USB microphone', 'audioinput', 'usb'),
    device('speaker', 'USB headphones', 'audiooutput', 'usb'),
    device('other', 'Built-in output', 'audiooutput', 'builtin')
  ];
  const physical = deviceLists(devices, defaults, { labels: endpointLabels });
  assert.equal(physical.outputs.length, 2);
  const microphone = chooseDevice(physical.inputs, '', 'audioinput', devices, {});
  assert.equal(chooseDevice(physical.outputs, '', 'audiooutput', devices, {}, microphone).deviceId, 'speaker');
  assert.throws(() => chooseDevice(physical.inputs, 'missing', 'audioinput', devices, {}), /disconnected/);
  assert.throws(() => chooseDevice(physical.outputs, '', 'audiooutput', devices, {}), /safe system default/);
});

test('external virtual routing rejects a single cable shared by both directions', () => {
  const devices = [device('in', 'Cable output', 'audioinput'), device('out', 'Cable input', 'audiooutput')];
  assert.throws(() => virtualEndpoints(devices, { virtualMicFeed: 'out', virtualMic: 'in', virtualSpeaker: 'out', virtualSpeakerCapture: 'in' }, { managed: false }), /separate/);
});

test('keys never enter public settings and basic_text is never used for persistence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-store-'));
  const insecure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw Error('must not encrypt'); } };
  try {
    const store = new SettingsStore(directory, insecure);
    const result = await store.save(defaults, 'test-key');
    assert.equal(result.hasKey, true); assert.equal(result.keyPersisted, false);
    assert.ok(!JSON.stringify(result).includes('test-key'));
    assert.ok(!(await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('test-key'));
    await assert.rejects(readFile(path.join(directory, 'credential.bin')), { code: 'ENOENT' });
    await store.forget(); assert.equal(store.public().hasKey, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('secure credentials reload separately from preferences and can be forgotten', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-store-'));
  const crypto = { isEncryptionAvailable: () => true, encryptString: key => Buffer.from(key).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() };
  try {
    const store = new SettingsStore(directory, crypto);
    await store.save({ ...defaults, voiceTarget: 'en' }, 'test-key');
    const restored = new SettingsStore(directory, crypto); await restored.load();
    assert.equal(restored.key, 'test-key'); assert.equal(restored.settings.voiceTarget, 'en');
    await restored.forget(); await assert.rejects(readFile(path.join(directory, 'credential.bin')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('routing cleanup leaves unrelated modules alone even when a saved ID was recycled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-routing-'));
  const unloaded = [];
  const routing = new AudioRouting(directory, { platform: 'linux', run: async (_command, args) => {
    if (args.includes('modules')) return { stdout: '42\tmodule-null-sink\tsink_name=someone_else\n43\tmodule-null-sink\tsink_name=gemini_audio_speaker' };
    if (args[0] === 'unload-module') { unloaded.push(args[1]); return { stdout: '' }; }
    throw Error('unexpected command');
  } });
  try {
    routing.records = [
      { id: 42, type: 'module-null-sink', identity: 'sink_name=gemini_audio_mic_feed' },
      { id: 43, type: 'module-null-sink', identity: 'sink_name=gemini_audio_speaker' }
    ];
    await routing.removeOwned(); assert.deepEqual(unloaded, ['43']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
