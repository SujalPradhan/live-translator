import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { endpointLabels } from './routing.mjs';

const execute = promisify(execFile);
const cables = [
  { name: 'voice', sink: 'gemini_audio_mic_feed', source: 'gemini_audio_mic', sinkLabel: 'GeminiMicFeed', sourceLabel: 'GeminiMic' },
  { name: 'listen', sink: 'gemini_audio_speaker', source: 'gemini_audio_speaker_capture', sinkLabel: 'GeminiSpeaker', sourceLabel: 'GeminiSpeakerCapture' }
];
const marker = name => `gemini-audio-loopback-${name}-v1`;
function loopbackArgs(cable) {
  const props = (name, description, mediaClass) => JSON.stringify({ 'node.name': name, 'node.description': description,
    'media.class': mediaClass, 'node.virtual': true, 'node.autoconnect': false, 'audio.position': ['FL', 'FR'], 'priority.session': 0 });
  return ['-n', marker(cable.name), '-c', '2', '-i', props(cable.sink, cable.sinkLabel, 'Audio/Sink'), '-o', props(cable.source, cable.sourceLabel, 'Audio/Source')];
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function pipewireInventory(objects) {
  const defaults = {};
  for (const object of objects.filter(o => o.type === 'PipeWire:Interface:Metadata' && o.props?.['metadata.name'] === 'default')) {
    for (const item of object.metadata || []) {
      try { defaults[item.key] = (typeof item.value === 'string' ? JSON.parse(item.value) : item.value)?.name; } catch {}
    }
  }
  return objects.filter(o => o.type === 'PipeWire:Interface:Node').flatMap(object => {
    const p = object.info?.props || {}, kind = p['media.class'] === 'Audio/Sink' ? 'audiooutput' : p['media.class'] === 'Audio/Source' ? 'audioinput' : null;
    if (!kind) return [];
    const name = p['node.name'];
    return [{ kind, nativeId: name, label: p['node.description'] || p['node.nick'] || name,
      group: String(p['device.id'] ?? ''), isDefault: defaults[kind === 'audioinput' ? 'default.audio.source' : 'default.audio.sink'] === name,
      isVirtual: p['node.virtual'] === true || p['node.virtual'] === 'true' || (!p['device.api'] && p['device.id'] === undefined) }];
  });
}

// Each helper owns one isolated sink/source pair. No system configuration or
// defaults are changed; removing the helper removes both endpoints.
export class PipeWireRouting {
  constructor({ run = execute, spawnProcess = spawn } = {}) {
    this.run = run; this.spawnProcess = spawnProcess; this.children = new Set(); this.busy = Promise.resolve();
  }
  async dump() { return JSON.parse((await this.run('pw-dump', ['-N'], { timeout: 6000, maxBuffer: 16 * 1024 * 1024 })).stdout); }
  async status() {
    try {
      const devices = pipewireInventory(await this.dump());
      const checks = cables.flatMap(c => [[c.sinkLabel, c.sink], [c.sourceLabel, c.source]])
        .map(([label, name]) => ({ label, present: devices.some(d => d.nativeId === name && d.label === label) }));
      const ready = checks.every(c => c.present);
      return { platform: 'linux', managed: true, ready, labels: endpointLabels, checks, devices,
        message: ready ? 'Native PipeWire virtual devices are ready.' : 'Create the native PipeWire virtual cables.' };
    } catch (error) { return { platform: 'linux', managed: true, ready: false, labels: endpointLabels, message: `Native PipeWire unavailable: ${error.message}` }; }
  }
  serial(action) { const task = this.busy.then(action); this.busy = task.catch(() => {}); return task; }
  reset() { return this.serial(async () => { await this.removeOwned(); return this.create(); }); }
  setup() { return this.serial(async () => { if ((await this.status()).ready) return this.status(); await this.removeOwned(); return this.create(); }); }
  remove() { return this.serial(async () => { await this.removeOwned(); return this.status(); }); }
  async create() {
    const devices = pipewireInventory(await this.dump());
    if (devices.some(d => cables.some(c => [c.sink, c.source].includes(d.nativeId))))
      throw Error('Old Gemini endpoints are still present. Close other app instances and remove their devices before using native PipeWire.');
    try {
      for (const cable of cables) {
        const child = this.spawnProcess('pw-loopback', loopbackArgs(cable),
        { stdio: ['ignore', 'ignore', 'pipe'] });
        child.failure = ''; child.stderr.on('data', data => { child.failure = (child.failure + data).slice(-2000); });
        child.on('error', error => { child.failure = error.message; });
        this.children.add(child);
      }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        for (const child of this.children) if (child.exitCode !== null || child.signalCode || child.failure.includes('ENOENT'))
          throw Error(child.failure || 'PipeWire loopback helper exited.');
        const status = await this.status(); if (status.ready) return status;
        await sleep(100);
      }
      throw Error('PipeWire did not expose all four virtual endpoints. Check the PipeWire service and permissions.');
    } catch (error) { await this.removeOwned().catch(() => {}); throw error; }
  }
  async removeOwned() {
    const stopped = [...this.children];
    for (const child of stopped) if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    // Recover helpers orphaned by an interrupted app. Verify the live process,
    // current user and exact private marker before sending any signal.
    let objects = [];
    try { objects = await this.dump(); } catch (error) { if (!stopped.length) throw error; }
    for (const object of objects.filter(o => o.type === 'PipeWire:Interface:Client')) {
      const pid = Number(object.info?.props?.['application.process.id']);
      if (!Number.isSafeInteger(pid) || pid <= 1 || stopped.some(c => c.pid === pid)) continue;
      try {
        const directory = `/proc/${pid}`;
        if ((await stat(directory)).uid !== process.getuid()) continue;
        const argv = (await readFile(`${directory}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        if (path.basename(argv[0]) !== 'pw-loopback' || argv[1] !== '-n' || !cables.some(c => argv[2] === marker(c.name))) continue;
        // The complete endpoint property arguments must match too.
        if (!cables.some(c => JSON.stringify(argv.slice(1)) === JSON.stringify(loopbackArgs(c)))) continue;
        process.kill(pid, 'SIGTERM');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    await Promise.all(stopped.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    })));
    this.children.clear();
    // Wait for server inventory to drop owned nodes before rebuilding.
    for (let attempt = 0; attempt < 15; attempt++) {
      const devices = pipewireInventory(await this.dump());
      if (!devices.some(d => cables.some(c => [c.sink, c.source].includes(d.nativeId)))) return;
      await sleep(80);
    }
  }
  watch(changed) {
    let stopped = false, running = false, previous;
    const timer = setInterval(async () => {
      if (stopped || running) return;
      running = true;
      try { const status = JSON.stringify(await this.status()); if (previous !== undefined && previous !== status) changed(); previous = status; }
      finally { running = false; }
    }, 1200);
    return () => { stopped = true; clearInterval(timer); };
  }
}
