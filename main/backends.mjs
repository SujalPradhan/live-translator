import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { AudioRouting, endpointLabels } from './routing.mjs';
import { PipeWireRouting } from './pipewire.mjs';

const execute = promisify(execFile);
export const backendIds = ['auto', 'pulse', 'pipewire', 'external'];
export const backendLabel = (id, platform = process.platform) => ({ auto: 'Automatic', pulse: 'PulseAudio / PipeWire Pulse (pactl)',
  pipewire: 'Native PipeWire / WirePlumber (without pactl)', external: platform === 'darwin' ? 'macOS CoreAudio · installed virtual cables' :
    platform === 'win32' ? 'Windows audio · installed virtual cables' : 'Existing virtual cables · manual mapping' })[id];

export async function probeBackend(id, { platform = process.platform, run = execute } = {}) {
  if (!backendIds.includes(id) || id === 'auto') throw Error('Choose a specific audio backend to check.');
  const report = { id, label: backendLabel(id, platform), platform, checkedAt: new Date().toISOString(), checks: [], available: false, guidance: [] };
  const check = async (label, command, args, validate = () => true, required = true) => {
    try {
      const { stdout } = await run(command, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
      if (!validate(stdout)) throw Error('Unexpected response.');
      report.checks.push({ label, passed: true, required, detail: 'Available' }); return true;
    } catch (error) {
      const detail = error.code === 'ENOENT' ? `${command} is not installed or not in the app PATH.` :
        error.killed ? `${command} timed out. Check that the audio service is running.` : `${command}: ${(error.stderr || error.message).trim().slice(0, 300)}`;
      report.checks.push({ label, passed: false, required, detail }); return false;
    }
  };
  if (id === 'external') {
    report.checks.push({ label: 'OS audio through Electron', passed: true, required: true, detail: 'No pactl or wpctl dependency. Physical and virtual endpoint access is checked in this window.' });
    report.available = true;
    report.guidance = [platform === 'darwin' ? 'Install two independent CoreAudio loopback cables (for example separately configured BlackHole devices), then map all four endpoints below.' :
      platform === 'win32' ? 'Install two independent Windows virtual cables (for example VB-CABLE A+B), then map all four endpoints below.' :
        'Map two existing independent virtual cables below. This mode does not create or delete driver devices.',
      'Installed third-party drivers remain installed when the app closes. Automatic device lifecycle is available only with the managed Linux backends.'];
    return report;
  }
  if (platform !== 'linux') {
    report.checks.push({ label: 'Operating system', passed: false, required: true, detail: 'Linux backend. Choose the installed virtual-cable backend on this OS.' });
    return report;
  }
  if (id === 'pulse') {
    if (await check('pactl command', 'pactl', ['--version'])) {
      if (await check('Audio server and JSON sink inventory', 'pactl', ['-f', 'json', 'list', 'sinks'], text => Array.isArray(JSON.parse(text)))) {
        await check('JSON microphone inventory', 'pactl', ['-f', 'json', 'list', 'sources'], text => Array.isArray(JSON.parse(text)));
        await check('Module management access', 'pactl', ['list', 'short', 'modules']);
      }
    }
    report.guidance = ['Install pulseaudio-utils for pactl. Keep your existing PulseAudio or pipewire-pulse server; there is no need to replace PipeWire with PulseAudio.',
      'Dependencies passing does not prove module creation is permitted. Use “Use selected & test routing” to create and verify the actual endpoints.'];
  } else {
    await check('pw-loopback command', 'pw-loopback', ['--version']);
    await check('pw-dump command and PipeWire server', 'pw-dump', ['-N'], text => Array.isArray(JSON.parse(text)));
    await check('WirePlumber / wpctl (optional)', 'wpctl', ['status'], () => true, false);
    report.guidance = ['Requires pw-loopback and pw-dump, usually provided by pipewire-bin on Ubuntu or pipewire-utils on Fedora. wpctl controls WirePlumber; it cannot create the two virtual cables by itself.',
      'This backend creates cables without pactl. Electron and your meeting browser must also expose the endpoints; on ordinary Chromium Linux installations this still requires a working pipewire-pulse service.'];
  }
  report.available = report.checks.filter(c => c.required).every(c => c.passed);
  if (!report.available) {
    let distro = '';
    try { distro = await readFile('/etc/os-release', 'utf8'); } catch {}
    if (/(?:ID|ID_LIKE)=.*(?:ubuntu|debian)/i.test(distro)) report.guidance.push(id === 'pulse' ? 'Ubuntu/Debian: sudo apt install pulseaudio-utils' : 'Ubuntu/Debian: sudo apt install pipewire-bin');
    if (/(?:ID|ID_LIKE)=.*(?:fedora|rhel)/i.test(distro)) report.guidance.push(id === 'pulse' ? 'Fedora: sudo dnf install pulseaudio-utils' : 'Fedora: sudo dnf install pipewire-utils');
  }
  return report;
}

export class AudioBackends {
  constructor(directory, { getSettings = () => ({}), platform = process.platform, run = execute, pulse, pipewire } = {}) {
    this.platform = platform; this.run = run; this.getSettings = getSettings;
    this.backends = { pulse: pulse || new AudioRouting(directory, { platform, run }), pipewire: pipewire || new PipeWireRouting({ run }) };
    this.active = null; this.busy = Promise.resolve(); this.listener = null; this.stopWatcher = null;
  }
  probe(id) { return probeBackend(id, { platform: this.platform, run: this.run }); }
  async candidates(requested) {
    if (!backendIds.includes(requested)) throw Error('Unknown audio backend.');
    if (requested !== 'auto') {
      const report = await this.probe(requested);
      if (!report.available) throw Error(report.checks.filter(c => c.required && !c.passed).map(c => c.detail).join(' '));
      return [requested];
    }
    if (this.platform !== 'linux') return ['external'];
    const ids = [];
    // Ordered, read-only checks. Missing pactl never prevents trying PipeWire.
    for (const id of ['pulse', 'pipewire']) if ((await this.probe(id)).available) ids.push(id);
    if (['virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture'].every(key => this.getSettings()[key])) ids.push('external');
    if (!ids.length) throw Error('No usable automatic audio backend found. Open Settings → Virtual devices → Check all backends for missing dependencies and setup steps.');
    return ids;
  }
  serialize(action) { const task = this.busy.then(action); this.busy = task.catch(() => {}); return task; }
  reset() { return this.serialize(() => this.activate(this.getSettings().audioBackend || 'auto', true)); }
  setup() { return this.serialize(async () => {
    if (!this.active) return this.activate(this.getSettings().audioBackend || 'auto', true);
    if (this.active !== 'external') {
      try { await this.backends[this.active].setup(); }
      catch (error) {
        if ((this.getSettings().audioBackend || 'auto') !== 'auto') throw error;
        return this.activate('auto', true);
      }
    }
    this.stopWatcher?.(); this.stopWatcher = null; this.startWatcher();
    return this.status();
  }); }
  select(id) { return this.serialize(() => this.activate(id, true)); }
  async activate(requested, fresh) {
    const candidates = await this.candidates(requested);
    const previous = this.active;
    this.stopWatcher?.(); this.stopWatcher = null;
    const errors = [];
    for (const id of candidates) {
      try {
        // Clean the previous backend before switching, and matching leftovers
        // from either managed backend at startup. Never uninstall external drivers.
        if (previous && previous !== id) await this.backends[previous]?.remove();
        if (this.platform === 'linux') for (const other of ['pulse', 'pipewire'].filter(key => key !== id)) {
          if ((await this.probe(other)).available) await this.backends[other].remove();
        }
        this.active = id;
        const result = id === 'external' ? this.externalStatus() : await this.backends[id][fresh ? 'reset' : 'setup']();
        this.startWatcher();
        return { ...result, activeBackend: id, backendLabel: backendLabel(id, this.platform) };
      } catch (error) {
        errors.push(`${backendLabel(id, this.platform)}: ${error.message}`);
        await this.backends[id]?.remove().catch(() => {});
      }
    }
    this.active = null;
    if (previous) {
      try {
        if (previous !== 'external') await this.backends[previous].reset();
        this.active = previous; this.startWatcher();
        errors.push('The previous audio backend was restored.');
      } catch (error) { errors.push(`Could not restore the previous backend: ${error.message}`); }
    }
    throw Error(errors.join('\n'));
  }
  externalStatus() { return { platform: this.platform, managed: false, ready: false, labels: endpointLabels,
    activeBackend: 'external', backendLabel: backendLabel('external', this.platform), message: 'Map two installed independent virtual cables in Settings → Virtual devices. Driver creation/removal is not managed in this mode.' }; }
  async status() {
    if (!this.active) return { platform: this.platform, managed: this.platform === 'linux', ready: false, labels: endpointLabels,
      activeBackend: null, message: 'Audio setup needs attention. Check backend dependencies in Settings → Virtual devices.' };
    const status = this.active === 'external' ? this.externalStatus() : await this.backends[this.active].status();
    return { ...status, activeBackend: this.active, backendLabel: backendLabel(this.active, this.platform) };
  }
  remove() { return this.serialize(async () => {
    this.stopWatcher?.(); this.stopWatcher = null;
    if (this.active && this.active !== 'external') await this.backends[this.active].remove();
    return this.status();
  }); }
  startWatcher() { if (this.listener && this.active && this.active !== 'external') this.stopWatcher = this.backends[this.active].watch(this.listener); }
  watch(changed) { this.listener = changed; this.startWatcher(); return () => { this.listener = null; this.stopWatcher?.(); this.stopWatcher = null; }; }
}
