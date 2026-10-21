// Real Electron + real PipeWire/PulseAudio; synthetic devices and Gemini server.
// No physical microphone capture, paid calls, or OS-default changes.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { PipeWireRouting } from '../main/pipewire.mjs';
import { AudioRouting } from '../main/routing.mjs';

const run = promisify(execFile);
const displayBackend = process.argv.includes('--wayland') ? 'wayland' : 'x11';
const noPactl = process.argv.includes('--no-pactl');
const nativePipewire = noPactl || process.argv.includes('--native-pipewire');
const reportSuffix = `${displayBackend}${nativePipewire ? '-pipewire' : ''}${noPactl ? '-no-pactl' : ''}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'test-artifacts');
await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'gemini-desktop-'));
const modules = [], children = [], checks = [];
let appProcess, browser, server, page, staleRouting;
let errors = [], logs = '';
async function pactl(...args) { return (await run('pactl', args)).stdout.trim(); }
async function module(type, ...args) { const id = await pactl('load-module', type, ...args); modules.push(id); return id; }
async function waitFor(condition, timeout = 20000) {
  const start = Date.now();
  while (!await condition()) { if (Date.now() - start > timeout) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
}
function power(samples, frequency, rate = 48000) {
  let real = 0, imaginary = 0;
  for (let index = 0; index < samples.length; index++) {
    real += samples[index] * Math.cos(2 * Math.PI * frequency * index / rate);
    imaginary += samples[index] * Math.sin(2 * Math.PI * frequency * index / rate);
  }
  return Math.hypot(real, imaginary) / samples.length;
}
async function expectTone(source, wanted, absent) {
  const result = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', source, '-t', '0.7', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', timeout: 8000, maxBuffer: 200000 });
  const samples = new Int16Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength / 2);
  const levels = Object.fromEntries([wanted, ...absent].map(frequency => [frequency, Math.round(power(samples, frequency))]));
  assert.ok(levels[wanted] > 150, `Expected ${wanted} Hz from ${source}: ${JSON.stringify(levels)}`);
  for (const frequency of absent) assert.ok(levels[frequency] < levels[wanted] * 0.12, `Unexpected ${frequency} Hz: ${JSON.stringify(levels)}`);
  return levels;
}
async function rmsAt(source) {
  const result = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', source, '-t', '0.4', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', timeout: 8000, maxBuffer: 200000 });
  const samples = new Int16Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength / 2);
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}
function tone(sink, frequency) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-f', 'pulse', '-device', sink, 'Fixture audio'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => { logs += data; }); children.push(child); return child;
}
try {
  const existing = JSON.parse(await pactl('-f', 'json', 'list', 'sinks'));
  assert.ok(!existing.some(item => /^(fixture_|gemini_audio_)/.test(item.name)), 'Close Gemini Audio before running the synthetic audio test.');
  await module('module-null-sink', 'sink_name=fixture_mic_input', 'sink_properties=device.description=FixtureMicInput', 'rate=48000');
  await module('module-remap-source', 'master=fixture_mic_input.monitor', 'source_name=fixture_mic', 'source_properties=device.description=FixtureMicrophone');
  await module('module-null-sink', 'sink_name=fixture_output', 'sink_properties=device.description=FixtureHeadphones', 'rate=48000');
  const altSink = await module('module-null-sink', 'sink_name=fixture_mic_alt_input', 'sink_properties=device.description=FixtureAlternativeInput', 'rate=44100', 'channels=1', 'channel_map=mono');
  const altSource = await module('module-remap-source', 'master=fixture_mic_alt_input.monitor', 'source_name=fixture_mic_alt', 'source_properties=device.description=FixtureAlternativeMicrophone', 'channels=1');
  staleRouting = nativePipewire ? new PipeWireRouting() : new AudioRouting(userData);
  await staleRouting.setup();
  const staleIds = JSON.parse(await pactl('-f', 'json', 'list', 'sinks')).filter(sink => sink.name.startsWith('gemini_audio_')).map(sink => sink.index);
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const received = { setups: 0, frames: 0 };
  server.on('connection', socket => {
    let phase = 0;
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.setup) { received.setups++; socket.send(JSON.stringify({ setupComplete: {} })); return; }
      if (!message.realtimeInput?.audio) return;
      received.frames++;
      const bytes = Buffer.from(message.realtimeInput.audio.data, 'base64');
      const input = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
      const voice = power(input, 440, 16000), listen = power(input, 660, 16000);
      const rms = Math.sqrt(input.reduce((sum, sample) => sum + sample * sample, 0) / input.length);
      if (rms < 100) return;
      const frequency = Math.max(voice, listen) > rms * 0.45 ? (voice > listen ? 880 : 990) : 770;
      const output = Buffer.alloc(Math.round(input.length * 24000 / 16000) * 2);
      for (let i = 0; i < output.length / 2; i++) { output.writeInt16LE(Math.round(5000 * Math.sin(phase)), i * 2); phase = (phase + 2 * Math.PI * frequency / 24000) % (2 * Math.PI); }
      socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: output.toString('base64') } }] } } }));
    });
  });
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const debugPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const executable = (await import('electron')).default;
  const environment = { ...process.env, GEMINI_TEST_USER_DATA: userData, GEMINI_TEST_NO_PACTL: noPactl ? '1' : '0', GEMINI_TEST_NATIVE_PIPEWIRE: nativePipewire && !noPactl ? '1' : '0', GEMINI_TEST_WS_PORT: String(server.address().port), PULSE_SOURCE: 'fixture_mic', PULSE_SINK: 'fixture_output' };
  delete environment.ELECTRON_RUN_AS_NODE;
  appProcess = spawn(executable, [path.join(root, 'tests/electron-harness.mjs'), `--remote-debugging-port=${debugPort}`, '--no-sandbox', `--ozone-platform=${displayBackend}`], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe']
  });
  appProcess.stdout.on('data', data => { logs += data; }); appProcess.stderr.on('data', data => { logs += data; });
  await waitFor(async () => { if (appProcess.exitCode !== null) throw Error(`Electron exited: ${logs}`); try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; } });
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null });
  await waitFor(async () => { page = (await browser.pages()).find(page => page.url().startsWith('app://gemini/')); return Boolean(page); });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => !document.getElementById('voice-toggle').disabled && !document.getElementById('listen-toggle').disabled, { timeout: 30000 });
  assert.equal(await page.$eval('#voice-mode', node => node.textContent), 'NORMAL');
  assert.equal(await page.$eval('#listen-mode', node => node.textContent), 'NORMAL');
  assert.equal((await page.evaluate(() => window.geminiAudio.routingStatus())).activeBackend, nativePipewire ? 'pipewire' : 'pulse');
  assert.equal(received.setups, 0); checks.push('Starts with both directions in normal mode and zero Gemini connections');
  const newNodes = JSON.parse(await pactl('-f', 'json', 'list', 'sinks')).filter(sink => sink.name.startsWith('gemini_audio_'));
  assert.ok(newNodes.every(sink => !staleIds.includes(sink.index)));
  checks.push('App startup removes stale virtual devices and creates fresh audio node IDs');
  console.log('Checking connection, virtual device health and translated sample playback…');
  await page.click('#settings-open');
  await page.focus('#tab-gemini'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#panel-audio', node => node.hidden), false);
  assert.equal(await page.$eval('#panel-gemini', node => node.hidden), true);
  await page.click('#tab-virtual');
  await page.click('#backend-check-all');
  await page.waitForFunction(() => document.getElementById('backend-progress').textContent.startsWith('Checked 3'));
  assert.equal(await page.$$eval('[data-backend-report]', nodes => nodes.length), 3);
  if (noPactl) assert.ok(await page.$eval('[data-backend-report=pulse]', node => node.textContent.includes('pactl is not installed')));
  checks.push('Backend checks report each dependency; unavailable pactl does not block native PipeWire');
  await page.click('#tab-gemini');
  checks.push('Settings tabs support keyboard navigation and keep virtual devices separate');
  await page.click('#check-connection');
  await page.waitForFunction(() => document.getElementById('connection-check-status').classList.contains('passed'));
  assert.equal(received.frames, 0); checks.push('Connection check succeeds without sending audio');
  await page.click('#tab-virtual');
  await page.click('#check-devices');
  await page.waitForFunction(() => document.getElementById('device-check-status').classList.contains('passed'));
  checks.push('Device health confirms all four virtual endpoints and both physical routes');
  await page.click('#settings-close');
  await page.click('#voice-check');
  await page.waitForFunction(() => document.getElementById('voice-check-status').textContent.includes('playing on'), { timeout: 15000 });
  const [headphoneRms, meetingMicRms] = await Promise.all([rmsAt('fixture_output.monitor'), rmsAt('gemini_audio_mic')]);
  assert.ok(headphoneRms > 300); assert.ok(meetingMicRms < 50);
  await page.waitForFunction(() => document.getElementById('voice-check-status').textContent.startsWith('Passed'), { timeout: 15000 });
  checks.push('Translated fixed sample plays on physical headphones and never enters the meeting microphone');
  await page.click('#listen-check');
  await page.waitForFunction(() => document.getElementById('listen-check').textContent === 'Cancel test');
  await page.focus('#listen-check'); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('listen-check-status').textContent.includes('cancelled'));
  checks.push('Sample translation checks can be cancelled');
  console.log('Checking normal passthrough through both real virtual cables…');
  const microphoneTone = tone('fixture_mic_input', 440);
  let meetingTone = tone('gemini_audio_speaker', 660);
  await new Promise(resolve => setTimeout(resolve, 600));
  checks.push({ normalVoice: await expectTone('gemini_audio_mic', 440, [660, 880, 990]) });
  checks.push({ normalListening: await expectTone('fixture_output.monitor', 660, [440, 880, 990]) });
  await page.screenshot({ path: path.join(artifacts, 'normal-audio.png'), fullPage: true });
  console.log('Checking voice translation and independent listening passthrough…');
  await page.click('#voice-toggle');
  await page.waitForFunction(() => document.getElementById('voice-mode').textContent === 'TRANSLATING');
  checks.push({ translatedVoiceOnly: await expectTone('gemini_audio_mic', 880, [440, 660, 990]) });
  checks.push({ listeningUnaffected: await expectTone('fixture_output.monitor', 660, [440, 880, 990]) });
  await page.click('#listen-toggle');
  console.log('Checking simultaneous translation…');
  await page.waitForFunction(() => document.getElementById('listen-mode').textContent === 'TRANSLATING');
  checks.push({ bothVoice: await expectTone('gemini_audio_mic', 880, [440, 660, 990]) });
  checks.push({ bothListening: await expectTone('fixture_output.monitor', 990, [440, 660, 880]) });
  await page.select('#theme', 'dark');
  await page.waitForFunction(async () => (await window.geminiAudio.getSettings()).settings.theme === 'dark');
  const darkBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await page.screenshot({ path: path.join(artifacts, `dark-${displayBackend}.png`), fullPage: true });
  await page.select('#theme', 'light');
  await page.waitForFunction(async () => (await window.geminiAudio.getSettings()).settings.theme === 'light');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), darkBackground);
  assert.equal(await page.$eval('#voice-mode', node => node.textContent), 'TRANSLATING');
  assert.equal(await page.$eval('#listen-mode', node => node.textContent), 'TRANSLATING');
  checks.push('Light and dark preferences persist without stopping either translation direction');
  await page.click('#settings-open'); await page.click('#tab-gemini'); await page.click('#check-connection');
  await page.waitForFunction(() => document.getElementById('connection-check-status').classList.contains('passed'));
  assert.equal(await page.$eval('#voice-mode', node => node.textContent), 'TRANSLATING');
  assert.equal(await page.$eval('#listen-mode', node => node.textContent), 'TRANSLATING');
  await page.click('#settings-close');
  checks.push('Connection health check leaves both active translation directions running');
  await page.click('#settings-open'); await page.click('#tab-virtual'); await page.click('#backend-check-all');
  await page.waitForFunction(() => document.getElementById('backend-progress').textContent.startsWith('Checked 3'));
  assert.equal(await page.$eval('#voice-mode', node => node.textContent), 'TRANSLATING');
  assert.equal(await page.$eval('#listen-mode', node => node.textContent), 'TRANSLATING');
  await page.$eval('#settings-dialog', node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(artifacts, `backends-${reportSuffix}.png`), fullPage: true });
  await page.click('#settings-close');
  checks.push('Iterative backend dependency checks leave both translations active');
  await page.screenshot({ path: path.join(artifacts, 'both-translating.png') });
  await page.click('#voice-toggle');
  checks.push({ stoppedVoiceRestoresOriginal: await expectTone('gemini_audio_mic', 440, [660, 880, 990]) });
  checks.push({ listeningStillTranslates: await expectTone('fixture_output.monitor', 990, [440, 660, 880]) });
  await page.click('#listen-toggle');
  checks.push({ stoppedListeningRestoresOriginal: await expectTone('fixture_output.monitor', 660, [440, 880, 990]) });
  if (!nativePipewire) {
    await page.click('#settings-open'); await page.click('#tab-virtual');
    for (const backend of ['pipewire', 'auto']) {
      meetingTone.kill('SIGTERM');
      await page.select('#audio-backend', backend); await page.click('#backend-apply');
      await page.waitForFunction(() => document.getElementById('backend-progress').textContent.startsWith('Passed'), { timeout: 25000 });
      assert.equal((await page.evaluate(() => window.geminiAudio.getSettings())).settings.audioBackend, backend);
      assert.equal((await page.evaluate(() => window.geminiAudio.routingStatus())).activeBackend, backend === 'auto' ? 'pulse' : 'pipewire');
      meetingTone = tone('gemini_audio_speaker', 660);
      await new Promise(resolve => setTimeout(resolve, 500));
      checks.push({ switchedBackend: backend, reconnectedMeetingOutput: true, voice: await expectTone('gemini_audio_mic', 440, [660, 880, 990]), listen: await expectTone('fixture_output.monitor', 660, [440, 880, 990]) });
    }
    await page.click('#settings-close');
  }
  await page.click('#settings-open');
  await page.click('#tab-audio');
  await page.$eval('#silenceSeconds', node => { node.value = '1'; });
  await page.click('#settings-save');
  await page.click('#voice-toggle');
  await page.waitForFunction(() => document.getElementById('voice-mode').textContent === 'TRANSLATING');
  microphoneTone.kill('SIGTERM');
  await page.waitForFunction(() => document.getElementById('voice-status').textContent.includes('Silence timeout'), { timeout: 7000 });
  checks.push('Source silence timeout restores normal mode independently');
  await page.click('#settings-open');
  await page.screenshot({ path: path.join(artifacts, 'settings.png') });
  const publicSettings = await page.evaluate(() => window.geminiAudio.getSettings());
  assert.ok(!JSON.stringify(publicSettings).includes('test-only-key')); checks.push('API key stays outside renderer settings');
  await page.click('#settings-close');
  console.log('Checking device switching, unplug handling and repair…');
  const altTone = tone('fixture_mic_alt_input', 550);
  const alternative = await page.$eval('#microphone', node => [...node.options].find(option => option.text === 'FixtureAlternativeMicrophone').value);
  await page.select('#microphone', alternative);
  await page.waitForFunction(() => document.getElementById('mic-selected').textContent === 'FixtureAlternativeMicrophone' && !document.getElementById('voice-toggle').disabled);
  checks.push({ switched44100HzMicrophone: await expectTone('gemini_audio_mic', 550, [440, 660, 880]) });
  altTone.kill('SIGTERM');
  await pactl('unload-module', altSource); modules.splice(modules.indexOf(altSource), 1);
  await pactl('unload-module', altSink); modules.splice(modules.indexOf(altSink), 1);
  await page.waitForFunction(() => document.getElementById('voice-toggle').disabled, { timeout: 7000 });
  assert.equal(await page.$eval('#listen-toggle', node => node.disabled), false);
  checks.push('Explicit microphone unplug disables only voice routing; listening remains connected');
  await page.select('#microphone', '');
  await page.waitForFunction(() => !document.getElementById('voice-toggle').disabled);
  checks.push('Selecting automatic microphone recovers routing');
  const modulesBeforeRepair = JSON.parse(await pactl('-f', 'json', 'list', 'sinks')).filter(item => item.name.startsWith('gemini_audio_')).length;
  if (nativePipewire) {
    const objects = JSON.parse((await run('pw-dump', ['-N'])).stdout);
    const capture = objects.find(object => object.info?.props?.['node.name'] === 'gemini_audio_speaker_capture');
    await run('pw-cli', ['destroy', String(capture.id)]);
  } else {
    const captureModule = (await pactl('list', 'short', 'modules')).split('\n').find(line => line.includes('source_name=gemini_audio_speaker_capture'));
    await pactl('unload-module', captureModule.split('\t')[0]);
  }
  await page.click('#settings-open');
  await page.click('#tab-virtual');
  await page.click('#check-devices');
  await page.waitForFunction(() => document.getElementById('device-check-status').classList.contains('failed'));
  assert.ok(await page.$eval('#device-check-status', node => node.textContent.includes('GeminiSpeakerCapture')));
  checks.push('Device health identifies a missing virtual endpoint');
  await page.click('#repair-routing');
  await page.waitForFunction(() => !document.getElementById('repair-routing').disabled);
  assert.equal(JSON.parse(await pactl('-f', 'json', 'list', 'sinks')).filter(item => item.name.startsWith('gemini_audio_')).length, modulesBeforeRepair);
  await page.click('#check-devices');
  await page.waitForFunction(() => document.getElementById('device-check-status').classList.contains('passed'));
  checks.push('Repair rebuilds a partial graph without duplicate virtual devices and device health returns to passed');
  await page.click('#settings-close');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  const report = { passed: true, displayBackend, audioBackend: nativePipewire ? 'pipewire' : 'pulse', pactlUnavailableToApp: noPactl, scope: 'Real Electron and Linux virtual devices; synthetic source/output devices and Gemini responses', paidCalls: 0, physicalMicrophoneCaptured: false, realMeetCall: false, received, checks };
  await writeFile(path.join(artifacts, `desktop-report-${reportSuffix}.json`), JSON.stringify(report, null, 2));
  await rm(path.join(artifacts, 'desktop-failure.log'), { force: true });
  await rm(path.join(artifacts, 'failure.png'), { force: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    const diagnostics = await page.evaluate(() => ({ notice: document.getElementById('notice').textContent,
      voice: document.getElementById('voice-status').textContent, listen: document.getElementById('listen-status').textContent,
      selected: document.getElementById('mic-selected').textContent,
      settings: document.getElementById('settings-error').textContent }));
    console.error(diagnostics); logs += JSON.stringify(diagnostics);
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  }
  await writeFile(path.join(artifacts, 'desktop-failure.log'), `${error.stack}\n\n${errors.join('\n')}\n\n${logs}`);
  console.error(error.stack); console.error(logs.slice(-6000)); process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (browser) {
    try { const page = (await browser.pages())[0]; await page.close(); } catch {}
    await browser.disconnect();
  }
  if (appProcess?.exitCode === null) {
    await Promise.race([once(appProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (appProcess.exitCode === null) appProcess.kill('SIGTERM');
  }
  const remaining = JSON.parse(await pactl('-f', 'json', 'list', 'sinks')).filter(item => item.name.startsWith('gemini_audio_'));
  if (remaining.length) { console.error('Virtual devices were not removed on app exit.'); process.exitCode = 1; }
  else console.log('Verified: app exit removes its virtual devices.');
  if (server) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
  for (const id of modules.reverse()) { try { await pactl('unload-module', id); } catch {} }
  await rm(userData, { recursive: true, force: true });
}
