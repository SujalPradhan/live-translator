import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const specs = [
  { type: 'module-null-sink', identity: 'sink_name=gemini_audio_mic_feed', args: ['sink_name=gemini_audio_mic_feed', 'sink_properties=device.description=GeminiMicFeed', 'channels=2', 'rate=48000'] },
  { type: 'module-remap-source', identity: 'source_name=gemini_audio_mic', args: ['master=gemini_audio_mic_feed.monitor', 'source_name=gemini_audio_mic', 'source_properties=device.description=GeminiMic', 'channels=2'] },
  { type: 'module-null-sink', identity: 'sink_name=gemini_audio_speaker', args: ['sink_name=gemini_audio_speaker', 'sink_properties=device.description=GeminiSpeaker', 'channels=2', 'rate=48000'] },
  { type: 'module-remap-source', identity: 'source_name=gemini_audio_speaker_capture', args: ['master=gemini_audio_speaker.monitor', 'source_name=gemini_audio_speaker_capture', 'source_properties=device.description=GeminiSpeakerCapture', 'channels=2'] }
];
export const endpointLabels = Object.freeze({
  virtualMicFeed: 'GeminiMicFeed', virtualMic: 'GeminiMic',
  virtualSpeaker: 'GeminiSpeaker', virtualSpeakerCapture: 'GeminiSpeakerCapture'
});

export class AudioRouting {
  constructor(directory, { platform = process.platform, run = execute } = {}) {
    this.directory = directory; this.platform = platform; this.run = run;
    this.records = []; this.busy = Promise.resolve();
  }
  async pactl(...args) {
    const result = await this.run('pactl', args, { timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  }
  async list(kind) {
    // Some pactl/PipeWire builds omit module indexes in JSON output. The short
    // tab-separated inventory includes the actual IDs needed for safe cleanup.
    if (kind === 'modules') return (await this.pactl('list', 'short', 'modules')).split('\n').flatMap(line => {
      const [index, name, argument = ''] = line.split('\t');
      return /^\d+$/.test(index) ? [{ index: Number(index), name, argument }] : [];
    });
    return JSON.parse(await this.pactl('-f', 'json', 'list', kind));
  }
  async loadRecords() {
    try { this.records = JSON.parse(await readFile(path.join(this.directory, 'routing.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('Routing record is unreadable. Restore it before removing existing Gemini devices.'); }
  }
  async saveRecords() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'routing.json');
    await writeFile(`${file}.tmp`, JSON.stringify(this.records), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async status() {
    if (this.platform !== 'linux') return {
      platform: this.platform, ready: false, managed: false, labels: endpointLabels,
      message: 'Select two installed virtual audio cables in Settings → Virtual audio setup. Native driver installation is required on this platform.'
    };
    try {
      const [sinks, sources, defaultSink, defaultSource] = await Promise.all([
        this.list('sinks'), this.list('sources'), this.pactl('get-default-sink'), this.pactl('get-default-source')
      ]);
      const checks = [
        ['GeminiMicFeed', sinks, 'gemini_audio_mic_feed'],
        ['GeminiMic', sources, 'gemini_audio_mic'],
        ['GeminiSpeaker', sinks, 'gemini_audio_speaker'],
        ['GeminiSpeakerCapture', sources, 'gemini_audio_speaker_capture']
      ].map(([label, devices, name]) => ({ label, present: devices.some(device => device.name === name) }));
      const ready = checks.every(check => check.present);
      const physical = (devices, kind, defaultName) => devices.filter(d =>
        !d.name.startsWith('gemini_audio_') && !d.name.endsWith('.monitor') &&
        d.properties?.['device.class'] !== 'monitor').map(d => ({
        kind, nativeId: d.name, label: d.description, isDefault: d.name === defaultName,
        group: d.properties?.['device.id'] || d.properties?.['device.serial'] || '',
        isVirtual: /null|loopback/.test(d.properties?.['factory.name'] || '') ||
          d.properties?.['node.virtual'] === 'true' || d.properties?.['device.class'] === 'abstract' ||
          (!d.properties?.['device.api'] && !(d.flags || []).includes('HARDWARE'))
      }));
      return { platform: 'linux', ready, managed: true, labels: endpointLabels, checks,
        devices: [...physical(sources, 'audioinput', defaultSource), ...physical(sinks, 'audiooutput', defaultSink)],
        message: ready ? 'Virtual audio devices are ready.' : 'Create GeminiMic and GeminiSpeaker to connect your meeting.' };
    } catch { return { platform: 'linux', ready: false, managed: true, labels: endpointLabels,
      message: 'Audio server unavailable. Start PipeWire/PulseAudio and install pactl (pulseaudio-utils), then retry.' }; }
  }
  watch(changed) {
    if (this.platform !== 'linux') return () => {};
    let stopped = false, child, retry, debounce;
    const notify = () => { clearTimeout(debounce); debounce = setTimeout(changed, 100); };
    const start = () => {
      if (stopped) return;
      child = spawn('pactl', ['subscribe'], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', data => {
        if (/on (sink|source|card|server)(?:\s|$)/.test(data.toString())) notify();
      });
      child.on('error', notify);
      child.on('close', () => { if (!stopped) { notify(); retry = setTimeout(start, 2000); } });
    };
    start();
    return () => { stopped = true; clearTimeout(retry); clearTimeout(debounce); child?.kill(); };
  }
  // Serialize repairs/removal so a double click cannot leak or delete modules.
  setup() {
    const task = this.busy.then(() => this.create());
    this.busy = task.catch(() => {});
    return task;
  }
  // A launch always starts with a fresh graph, including leftovers after a
  // crash or a different user-data directory. Only our exact module signatures
  // or verified saved IDs are eligible; unrelated virtual cables stay intact.
  reset() {
    const task = this.busy.then(async () => {
      if (this.platform !== 'linux') return this.status();
      await this.discoverOwned();
      await this.removeOwned();
      return this.create();
    });
    this.busy = task.catch(() => {});
    return task;
  }
  async discoverOwned() {
    try { await this.loadRecords(); } catch { this.records = []; }
    const modules = await this.list('modules');
    this.records = modules.flatMap(module => {
      const tokens = module.argument?.split(/\s+/) || [];
      const saved = this.records.find(record => record.id === module.index && record.type === module.name && tokens.includes(record.identity));
      const spec = specs.find(spec => spec.type === module.name && spec.args.every(arg => tokens.includes(arg)));
      return saved || spec ? [{ id: module.index, type: module.name, identity: saved?.identity || spec.identity }] : [];
    });
  }
  async create() {
    if (this.platform !== 'linux') return this.status();
    await this.loadRecords();
    const modules = await this.list('modules');
    const live = this.records.filter(record => modules.some(m =>
      m.index === record.id && m.name === record.type && m.argument?.split(/\s+/).includes(record.identity)));
    const owned = new Set(live.map(record => record.identity));
    for (const spec of specs) {
      if (modules.some(m => m.argument?.split(/\s+/).includes(spec.identity)) && !owned.has(spec.identity))
        throw Error('A Gemini audio device already exists outside this installation. Close the other instance before setup.');
    }
    this.records = live;
    const current = await this.status();
    if (live.length === specs.length && current.ready) return current;
    // Rebuild a partial graph together: a remap source can otherwise retain a
    // dead reference when its master sink was removed by the audio server.
    if (live.length) await this.removeOwned();
    try {
      for (const spec of specs) {
        const id = Number(await this.pactl('load-module', spec.type, ...spec.args));
        this.records.push({ id, type: spec.type, identity: spec.identity });
        await this.saveRecords();
      }
      return await this.status();
    } catch (error) {
      await this.removeOwned().catch(() => {});
      throw Error(`Virtual audio setup failed: ${error.message}`);
    }
  }
  remove() {
    const task = this.busy.then(async () => {
      if (this.platform !== 'linux') return this.status();
      await this.discoverOwned(); await this.removeOwned(); return this.status();
    });
    this.busy = task.catch(() => {});
    return task;
  }
  async removeOwned() {
    if (this.platform !== 'linux') return;
    const modules = await this.list('modules');
    const failed = [];
    for (const record of [...this.records].reverse()) {
      const match = modules.find(m => m.index === record.id && m.name === record.type &&
        m.argument?.split(/\s+/).includes(record.identity));
      if (match) {
        try { await this.pactl('unload-module', String(record.id)); }
        catch { failed.unshift(record); }
      }
    }
    this.records = failed;
    if (failed.length) { await this.saveRecords(); throw Error('Some audio devices are still busy. Close the meeting and retry.'); }
    await rm(path.join(this.directory, 'routing.json'), { force: true });
  }
}
