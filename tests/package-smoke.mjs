// Launches the actual packaged app with the normal Chromium sandbox enabled.
// No translation is started; no audio is recorded or sent to Gemini.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const displayBackend = process.argv.includes('--wayland') ? 'wayland' : 'x11';
const appImage = process.argv.includes('--appimage');
const noPactl = process.argv.includes('--no-pactl');
const nativePipewire = noPactl || process.argv.includes('--native-pipewire');
const suffix = `${displayBackend}${nativePipewire ? '-pipewire' : ''}${noPactl ? '-no-pactl' : ''}${appImage ? '-appimage' : ''}`;
const run = promisify(execFile);
const profile = await mkdtemp(path.join(os.tmpdir(), 'gemini-package-'));
const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
if (noPactl) {
  const tools = path.join(profile, 'tools'); await mkdir(tools);
  for (const command of ['pw-loopback', 'pw-dump', 'wpctl']) {
    const executable = (await run('which', [command])).stdout.trim();
    await symlink(executable, path.join(tools, command));
  }
  environment.PATH = tools;
} else if (nativePipewire) {
  const { defaults } = await import('../shared/settings.js');
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ ...defaults, audioBackend: 'pipewire' }));
}
const executable = appImage ? path.join(root, 'release', (await readdir(path.join(root, 'release'))).find(name => name.endsWith('.AppImage'))) : path.join(root, 'release/linux-unpacked/gemini-audio');
const child = spawn(executable, [...(appImage ? ['--appimage-extract-and-run'] : []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--ozone-platform=${displayBackend}`], {
  env: environment, stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '', browser;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
try {
  const start = Date.now();
  while (true) {
    if (child.exitCode !== null) throw Error(`Packaged app exited: ${logs}`);
    if (Date.now() - start > 30000) throw Error('Packaged app startup timed out.');
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width: 720, height: 850 } });
  let page;
  while (!page) {
    page = (await browser.pages()).find(page => page.url().startsWith('app://gemini/'));
    if (Date.now() - start > 40000) throw Error('Packaged app did not open its window.');
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  await page.waitForFunction(() => !document.getElementById('voice-toggle').disabled && !document.getElementById('listen-toggle').disabled, { timeout: 20000 });
  assert.equal(await page.$eval('#voice-mode', node => node.textContent), 'NORMAL');
  assert.equal(await page.$eval('#listen-mode', node => node.textContent), 'NORMAL');
  const credentials = await page.evaluate(() => window.geminiAudio.getSettings());
  assert.equal(credentials.hasKey, false);
  assert.equal((await page.evaluate(() => window.geminiAudio.routingStatus())).activeBackend, nativePipewire ? 'pipewire' : 'pulse');
  await page.select('#theme', 'dark');
  await page.waitForFunction(async () => (await window.geminiAudio.getSettings()).settings.theme === 'dark');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('voice-toggle').disabled && document.getElementById('theme').value === 'dark');
  assert.ok(await page.$eval('body', node => parseFloat(getComputedStyle(node).fontSize) >= 16));
  await mkdir(path.join(root, 'test-artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, `test-artifacts/packaged-dark-${displayBackend}.png`), fullPage: true });
  await page.click('#voice-toggle');
  assert.equal(await page.$eval('#settings-dialog', node => node.open), true);
  await page.click('#check-connection');
  await page.waitForFunction(() => document.getElementById('connection-check-status').classList.contains('failed'));
  assert.ok(await page.$eval('#connection-check-status', node => node.textContent.includes('API key')));
  await page.$eval('#settings-dialog', node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, `test-artifacts/packaged-gemini-${displayBackend}.png`), fullPage: true });
  await page.click('#tab-virtual');
  await page.click('#backend-check-all');
  await page.waitForFunction(() => document.getElementById('backend-progress').textContent.startsWith('Checked 3'));
  assert.equal(await page.$$eval('[data-backend-report]', nodes => nodes.length), 3);
  if (noPactl) assert.ok(await page.$eval('[data-backend-report=pulse]', node => node.textContent.includes('pactl is not installed')));
  await page.select('#audio-backend', nativePipewire ? 'auto' : 'pipewire');
  await page.click('#backend-apply');
  await page.waitForFunction(() => document.getElementById('backend-progress').textContent.startsWith('Passed'), { timeout: 25000 });
  assert.equal((await page.evaluate(() => window.geminiAudio.routingStatus())).activeBackend, 'pipewire');
  await page.$eval('#settings-dialog', node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, `test-artifacts/packaged-backends-${suffix}.png`), fullPage: true });
  await page.click('#check-devices');
  await page.waitForFunction(() => document.getElementById('device-check-status').classList.contains('passed'));
  await page.screenshot({ path: path.join(root, 'test-artifacts/packaged-health-checks.png'), fullPage: true });
  assert.equal(await page.$eval('#panel-gemini', node => node.hidden), true);
  await page.click('#settings-close');
  await page.select('#theme', 'light');
  await page.waitForFunction(async () => (await window.geminiAudio.getSettings()).settings.theme === 'light');
  await page.screenshot({ path: path.join(root, `test-artifacts/packaged-light-${displayBackend}.png`), fullPage: true });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const report = { passed: true, displayBackend, appImage, nativePipewire, pactlAbsentFromAppPath: noPactl, backendReports: true, backendApplyPasses: true, packagedExecutable: true, sandboxDisabled: false, themeSurvivesReload: true, separateSettingsTabs: true, defaultVoice: 'normal', defaultListening: 'normal',
    emptyKeyOpensSettings: true, missingKeyHealthFailsClearly: true, deviceHealthPasses: true, paidCalls: 0, audioRecorded: false };
  await writeFile(path.join(root, `test-artifacts/package-report-${suffix}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await page.close();
} catch (error) { console.error(error.message); console.error(logs); process.exitCode = 1; }
finally {
  browser?.disconnect();
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 8000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
  const sinks = JSON.parse((await run('pactl', ['-f', 'json', 'list', 'sinks'])).stdout);
  assert.ok(!sinks.some(sink => sink.name.startsWith('gemini_audio_')), 'Packaged app did not clean up its devices.');
}
