import { defaults, languages } from '../shared/settings.js';
import { AudioRoute } from './route.js';
import { chooseDevice, deviceLists, isAlias, suggestMappings, virtualEndpoints } from './devices.js';
import { SamplePlayer } from './sample-player.js';

const $ = id => document.getElementById(id);
const bridge = window.geminiAudio;
let settings = { ...defaults }, credentials = {}, native = {}, devices = [];
let refreshing = Promise.resolve(), saving = Promise.resolve(), deviceTimer;
let disposed = false;
let settingsTab = 'gemini';
let checking = null;
let draftMappings = null;
const samplePlayer = new SamplePlayer();
try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'system'; } catch {}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').value = theme;
  try { localStorage.setItem('theme', theme); } catch {}
}
function showSettingsTab(tab, focus = false) {
  settingsTab = ['gemini', 'audio', 'virtual'].includes(tab) ? tab : 'gemini';
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === settingsTab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== settingsTab;
  if (focus) $('tab-' + settingsTab).focus();
}
for (const button of document.querySelectorAll('[data-settings-tab]')) {
  button.addEventListener('click', () => showSettingsTab(button.dataset.settingsTab));
  button.addEventListener('keydown', event => {
    const tabs = ['gemini', 'audio', 'virtual']; let index = tabs.indexOf(settingsTab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); showSettingsTab(tabs[index], true);
  });
}
$('theme').addEventListener('change', async () => {
  const previous = settings.theme;
  applyTheme($('theme').value);
  try { await persist({ theme: $('theme').value }); }
  catch (error) { settings.theme = previous; applyTheme(previous); notice(cleanError(error)); }
});

function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function cleanError(error) { return error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
const routes = Object.fromEntries(['voice', 'listen'].map(direction => [direction, new AudioRoute(direction, bridge, state => {
  $(direction + '-status').textContent = state.message;
  const button = $(direction + '-toggle');
  button.textContent = state.translating ? 'Stop translation  ■' : 'Start translation  ↗';
  button.disabled = !state.ready;
  $(direction + '-card').classList.toggle('active', state.phase === 'translating');
  $(direction + '-card').classList.toggle('connecting', ['connecting', 'reconnecting'].includes(state.phase));
  $(direction + '-mode').textContent = state.phase === 'translating' ? 'TRANSLATING' : state.translating ? 'CONNECTING' : 'NORMAL';
  const connected = routes?.voice?.ready && routes?.listen?.ready;
  $('connection').textContent = connected ? 'Audio connected' : 'Check devices';
  $('connection').classList.toggle('ready', Boolean(connected));
})]));

function optionList(element, items, selected, placeholder) {
  element.replaceChildren(new Option(placeholder, ''));
  for (const device of items) element.add(new Option(device.label || 'Unnamed device', device.deviceId));
  if (selected && !items.some(device => device.deviceId === selected)) element.add(new Option('Selected device · disconnected', selected));
  element.value = selected;
}
function renderDevices() {
  const physical = deviceLists(devices, settings, native);
  optionList($('microphone'), physical.inputs, settings.microphone, 'System default · automatic');
  optionList($('speaker'), physical.outputs, settings.speaker, 'System default · automatic');
  for (const [name, kind] of Object.entries({ virtualMicFeed: 'audiooutput', virtualMic: 'audioinput', virtualSpeaker: 'audiooutput', virtualSpeakerCapture: 'audioinput' }))
    optionList($(name), devices.filter(device => device.kind === kind && !isAlias(device)), draftMappings?.[name] ?? settings[name], 'Select a virtual cable device');
}
function renderRouting() {
  $('backend-current').textContent = `Saved: ${settings.audioBackend || 'auto'} · Active: ${native.backendLabel || 'No backend connected'}`;
  if (native.platform === 'darwin') $('audio-backend').querySelector('[value="external"]').textContent = 'macOS CoreAudio · installed virtual cables';
  if (native.platform === 'win32') $('audio-backend').querySelector('[value="external"]').textContent = 'Windows audio · installed virtual cables';
  $('external-routing').hidden = native.managed && $('audio-backend').value !== 'external';
  $('remove-routing').hidden = !native.managed;
  $('routing-description').textContent = native.managed
    ? 'Managed Linux devices are recreated on launch and removed on close. Your system defaults are left unchanged.'
    : native.message;
}
function renderCredentials() {
  $('api-key').placeholder = credentials.hasKey ? 'API key is set · leave blank to keep it' : 'Enter your Gemini API key';
  $('key-status').textContent = credentials.hasKey
    ? credentials.keyPersisted ? 'Key saved using your OS keyring.' : 'Key is kept for this app session only.'
    : credentials.secureStorage ? 'Keys can be saved using your OS keyring.' : 'No secure keyring available. Keys will stay in memory only.';
  $('forget-key').hidden = !credentials.hasKey;
}
function persist(patch = {}, key) {
  settings = { ...settings, ...patch };
  const snapshot = { ...settings };
  const task = saving.then(() => bridge.saveSettings(snapshot, key)).then(result => {
    credentials = result; renderCredentials(); return result;
  });
  saving = task.catch(() => {});
  return task;
}

async function connectAudio(force = false) {
  if (disposed) return;
  native = await bridge.routingStatus();
  devices = await navigator.mediaDevices.enumerateDevices();
  renderRouting(); renderDevices();
  try {
    if (native.managed && !native.ready) throw Error(native.message);
    // Installed cables (for example BlackHole 2ch + 16ch) with no usable
    // mapping, whether empty or stale: map them automatically instead of
    // asking for four manual selections. A valid mapping is never replaced.
    if (!native.managed) {
      let valid = true;
      try { virtualEndpoints(devices, settings, native); } catch { valid = false; }
      const suggestion = !valid && suggestMappings(devices);
      if (suggestion) { await persist(suggestion); renderDevices(); }
    }
    const endpoints = virtualEndpoints(devices, settings, native);
    const lists = deviceLists(devices, settings, native);
    let input, output, inputError, outputError;
    // Start with the system listening device, then pair its microphone when
    // the OS exposes exactly one input in the same physical-device group.
    try { output = chooseDevice(lists.outputs, settings.speaker, 'audiooutput', devices, native); }
    catch (error) { outputError = error; }
    try { input = chooseDevice(lists.inputs, settings.microphone, 'audioinput', devices, native, output); }
    catch (error) { inputError = error; }
    if (!settings.speaker && settings.microphone && input) {
      try { output = chooseDevice(lists.outputs, '', 'audiooutput', devices, native, input); outputError = null; } catch {}
    }
    if (!output && !settings.speaker && input) {
      try { output = chooseDevice(lists.outputs, '', 'audiooutput', devices, native, input); outputError = null; } catch {}
    }
    $('mic-selected').textContent = input?.label || 'Choose a connected microphone';
    $('speaker-selected').textContent = output?.label || 'Choose a connected listening device';
    $('meet-mic').textContent = endpoints.virtualMic.label;
    $('meet-speaker').textContent = endpoints.virtualSpeaker.label;
    $('setup').hidden = true;
    for (const direction of ['voice', 'listen']) {
      const route = routes[direction];
      const source = direction === 'voice' ? input : endpoints.virtualSpeakerCapture;
      const sink = direction === 'voice' ? endpoints.virtualMicFeed : output;
      const error = direction === 'voice' ? inputError : outputError;
      if (error || !source || !sink) {
        if (direction === 'listen' && checking?.kind === 'sample') cancelCheck();
        await route.close(); route.announce(error?.message || 'Choose your audio device.'); continue;
      }
      const identity = `${source.deviceId}:${sink.deviceId}`;
      if (!force && route.ready && route.identity === identity) continue;
      const wasTranslating = route.translating;
      await route.close();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
          deviceId: { exact: source.deviceId }, echoCancellation: false,
          noiseSuppression: false, autoGainControl: false
        } });
        if (disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        await route.configure(stream, sink.deviceId, settings);
        route.identity = identity;
        for (const track of stream.getAudioTracks()) track.onended = () => {
          route.close().then(() => route.announce('Audio device disconnected · reconnect or choose another device.'));
          refreshAudio();
        };
        if (wasTranslating) route.announce('Device changed · normal audio. Press Start to translate.');
      } catch (error) {
        await route.close(); route.announce(`Audio unavailable: ${cleanError(error)}`);
        notice('Audio could not connect. Check device permissions, then use Settings → Repair / refresh audio.');
      }
    }
  } catch (error) {
    await Promise.all(Object.values(routes).map(route => route.close()));
    $('setup').hidden = false;
    $('setup-message').textContent = native.managed && !native.ready ? native.message : cleanError(error);
    for (const route of Object.values(routes)) route.announce('Audio setup needed');
  }
}
function refreshAudio(force = false) {
  const task = refreshing.then(() => connectAudio(force));
  refreshing = task.catch(error => notice(cleanError(error)));
  return refreshing;
}
function openSettings(tab = settingsTab) {
  draftMappings = null;
  $('audio-backend').value = settings.audioBackend || 'auto';
  for (const name of ['model', 'baseUrl', 'chunkMs', 'playbackBufferMs', 'maxBufferMs', 'silenceSeconds']) $(name).value = settings[name];
  $('echoTargetLanguage').checked = settings.echoTargetLanguage;
  $('api-key').value = ''; $('settings-error').hidden = true;
  checkResult('connection-check-status', '');
  renderCredentials(); renderRouting(); renderDevices();
  $('audio-backend').value = settings.audioBackend || 'auto';
  showSettingsTab(tab);
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
}

function checkResult(id, text, ok) {
  const element = $(id); element.textContent = text;
  element.classList.toggle('passed', ok === true); element.classList.toggle('failed', ok === false);
}
function renderCheckButtons() {
  for (const direction of ['voice', 'listen']) {
    const own = checking?.kind === 'sample' && checking.direction === direction;
    $(direction + '-check').textContent = own ? 'Cancel test' : 'Test with sample';
    $(direction + '-check').disabled = Boolean(checking && !own);
  }
  $('check-connection').textContent = checking?.kind === 'connection' ? 'Cancel check' : 'Check connection';
  $('check-connection').disabled = Boolean(checking && checking.kind !== 'connection');
}
function cancelCheck() {
  if (checking) checking.cancelled = true;
  samplePlayer.stop(); void bridge.cancelHealthChecks().catch(() => {});
}
async function runCheck(kind, direction = 'voice') {
  if (checking) { if (checking.kind === kind && checking.direction === direction) cancelCheck(); return; }
  if (kind === 'sample' && !credentials.hasKey) { openSettings('gemini'); $('api-key').focus(); return; }
  if (kind === 'sample' && !routes.listen.ready) { notice('Connect a physical listening device before playing a test sample.'); return; }
  const current = checking = { kind, direction, cancelled: false };
  const resultId = kind === 'connection' ? 'connection-check-status' : direction + '-check-status';
  checkResult(resultId, kind === 'connection' ? 'Connecting…' : 'Translating a short English sample…');
  renderCheckButtons();
  try {
    await saving;
    const draft = kind === 'connection' ? { model: $('model').value.trim(), baseUrl: $('baseUrl').value.trim() } : {};
    const key = kind === 'connection' ? $('api-key').value || undefined : undefined;
    const result = await bridge.checkHealth(kind, direction, draft, key);
    if (disposed) return;
    if (current.cancelled || result.cancelled) { checkResult(resultId, 'Check cancelled.'); return; }
    if (!result.ok) { checkResult(resultId, result.message, false); return; }
    if (kind === 'connection') checkResult(resultId, result.message, true);
    else {
      if (!routes.listen.ready) throw Error('Gemini returned audio, but your listening device is disconnected.');
      checkResult(resultId, 'Translation received · playing on your listening device…', true);
      const completed = await samplePlayer.play(result.audio, routes.listen.sinkId);
      checkResult(resultId, completed ? `Passed · ${result.seconds.toFixed(1)}s of translated audio played.` : 'Test stopped.', completed ? true : undefined);
    }
  } catch (error) { if (!disposed) checkResult(resultId, cleanError(error), false); }
  finally { if (checking === current) checking = null; renderCheckButtons(); }
}
async function checkDevices() {
  checkResult('device-check-status', 'Checking virtual devices and physical audio…');
  $('check-devices').disabled = true;
  try {
    await refreshAudio();
    if (native.managed && !native.ready) {
      const missing = native.checks?.filter(check => !check.present).map(check => check.label);
      throw Error(missing?.length ? `Missing: ${missing.join(', ')}. Use Repair / refresh audio.` : native.message);
    }
    virtualEndpoints(devices, settings, native);
    if (!routes.voice.ready || !routes.listen.ready) throw Error('Virtual devices found. Connect your physical microphone and listening device.');
    const message = 'Passed · all 4 virtual endpoints found. Microphone and listening device connected.';
    checkResult('device-check-status', message, true); notice(message);
  } catch (error) { checkResult('device-check-status', cleanError(error), false); notice(cleanError(error)); }
  finally { $('check-devices').disabled = false; }
}
$('check-connection').addEventListener('click', () => runCheck('connection'));
for (const id of ['api-key', 'model', 'baseUrl']) $(id).addEventListener('input', () => {
  if (checking?.kind === 'connection') cancelCheck();
  checkResult('connection-check-status', 'Connection settings changed · check again.');
});
$('check-devices').addEventListener('click', checkDevices);
$('connection').addEventListener('click', () => { openSettings('virtual'); void checkDevices(); });
for (const direction of ['voice', 'listen']) $(direction + '-check').addEventListener('click', () => runCheck('sample', direction));

for (const direction of ['voice', 'listen']) {
  const selector = $(direction + '-target');
  for (const [name, code] of languages) selector.add(new Option(name, code));
  selector.value = 'hi';
  selector.addEventListener('change', async () => {
    if (checking?.kind === 'sample' && checking.direction === direction) cancelCheck();
    routes[direction].stop('Language changed · normal audio');
    try { await persist({ [direction + 'Target']: selector.value }); } catch (error) { notice(cleanError(error)); }
  });
  $(direction + '-toggle').addEventListener('click', async () => {
    const route = routes[direction];
    if (route.translating) { route.stop(); return; }
    if (!credentials.hasKey) { openSettings('gemini'); $('api-key').focus(); return; }
    await saving;
    route.start(settings).catch(error => notice(cleanError(error)));
  });
}
for (const id of ['microphone', 'speaker']) $(id).addEventListener('change', async () => {
  cancelCheck();
  routes[id === 'microphone' ? 'voice' : 'listen'].stop('Changing device · normal audio');
  try { await persist({ [id]: $(id).value }); await refreshAudio(); } catch (error) { notice(cleanError(error)); }
});
$('settings-open').addEventListener('click', () => openSettings());
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; if (checking?.kind === 'connection') cancelCheck(); });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const invalid = [...$('settings-form').querySelectorAll('input[required]')].find(input => !input.validity.valid);
  if (invalid) {
    showSettingsTab(invalid.closest('[data-settings-panel]').dataset.settingsPanel);
    invalid.reportValidity(); return;
  }
  $('settings-save').disabled = true;
  const patch = {};
  for (const name of ['model', 'baseUrl']) patch[name] = $(name).value.trim();
  for (const name of ['chunkMs', 'playbackBufferMs', 'maxBufferMs', 'silenceSeconds']) patch[name] = Number($(name).value);
  patch.echoTargetLanguage = $('echoTargetLanguage').checked;
  if (!native.managed) for (const name of ['virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture']) patch[name] = $(name).value;
  const previous = settings;
  try {
    // Validate before stopping or replacing any live configuration.
    const { validateSettings } = await import('../shared/settings.js');
    validateSettings({ ...settings, ...patch });
    cancelCheck();
    Object.values(routes).forEach(route => route.stop());
    await persist(patch, $('api-key').value || undefined);
    $('api-key').value = '';
    for (const route of Object.values(routes)) route.settings = { ...settings };
    $('settings-dialog').close();
    notice('Settings saved. Audio stays normal until you press Start.');
    await refreshAudio();
  } catch (error) {
    settings = previous; $('settings-error').textContent = cleanError(error); $('settings-error').hidden = false;
  } finally { $('settings-save').disabled = false; }
});
$('forget-key').addEventListener('click', async () => {
  cancelCheck();
  Object.values(routes).forEach(route => route.stop());
  credentials = await bridge.forgetKey(); $('api-key').value = ''; renderCredentials();
});
async function setupAudio() {
  if (!native.managed) { openSettings('virtual'); return; }
  $('setup-button').disabled = true;
  try {
    native = await bridge.setupRouting();
    if (!native.ready) throw Error(native.message);
    await refreshAudio(); notice();
  } catch (error) { notice(cleanError(error)); }
  finally { $('setup-button').disabled = false; }
}
$('setup-button').addEventListener('click', setupAudio);
$('repair-routing').addEventListener('click', async () => {
  cancelCheck();
  $('repair-routing').disabled = true;
  try {
    if (native.managed) native = await bridge.setupRouting();
    await refreshAudio(true);
    $('routing-description').textContent = native.ready ? 'Audio devices refreshed. Both directions are in normal audio mode.' : native.message;
  } catch (error) { $('routing-description').textContent = cleanError(error); }
  finally { $('repair-routing').disabled = false; }
});
$('remove-routing').addEventListener('click', async () => {
  cancelCheck();
  await Promise.all(Object.values(routes).map(route => route.close()));
  try { native = await bridge.removeRouting(); await refreshAudio(); $('settings-dialog').close(); }
  catch (error) { $('routing-description').textContent = cleanError(error); }
});
function readMappings() {
  return Object.fromEntries(['virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture'].map(id => [id, $(id).value]));
}
for (const id of ['virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture']) $(id).addEventListener('change', () => { draftMappings = readMappings(); });
$('audio-backend').addEventListener('change', renderRouting);
let backendBusy = false;
function setBackendBusy(busy) {
  backendBusy = busy;
  for (const id of ['backend-check', 'backend-check-all', 'backend-apply', 'audio-backend', 'repair-routing', 'remove-routing', 'settings-save']) $(id).disabled = busy;
}
function backendReport(report) {
  const container = $('backend-reports');
  container.querySelector(`[data-backend-report="${report.id}"]`)?.remove();
  const card = document.createElement('article'); card.className = 'backend-report'; card.dataset.backendReport = report.id;
  const heading = document.createElement('h4'); heading.textContent = report.label; card.append(heading);
  const summary = document.createElement('p'); summary.className = 'check-result ' + (report.available ? 'passed' : 'failed');
  summary.textContent = report.available ? 'Dependencies/configuration available · routing still needs testing' : report.id === 'external' ? 'Setup incomplete · check installed cables and mapping' : 'Required dependencies unavailable'; card.append(summary);
  const list = document.createElement('ul');
  for (const check of report.checks) {
    const item = document.createElement('li');
    item.textContent = `${check.passed ? '✓' : check.required ? '✕' : '○'} ${check.label}: ${check.detail}`;
    item.className = check.passed ? 'passed' : check.required ? 'failed' : ''; list.append(item);
  }
  card.append(list);
  for (const text of report.guidance) { const line = document.createElement('p'); line.className = 'hint'; line.textContent = text; card.append(line); }
  container.append(card);
}
async function checkBackends(all) {
  if (backendBusy) return;
  setBackendBusy(true); $('backend-reports').replaceChildren();
  const selected = $('audio-backend').value;
  const ids = all || selected === 'auto' ? ['pulse', 'pipewire', 'external'] : [selected];
  let available = 0;
  try {
    for (let index = 0; index < ids.length; index++) {
      $('backend-progress').textContent = `Checking ${index + 1} of ${ids.length}…`;
      const report = await bridge.checkAudioBackend(ids[index]);
      if (report.id === 'external') {
        try {
          const endpoints = virtualEndpoints(await navigator.mediaDevices.enumerateDevices(), { ...settings, ...readMappings() }, { managed: false });
          for (const [name, device] of Object.entries(endpoints)) report.checks.push({ label: name, passed: true, required: true, detail: device.label });
        } catch (error) {
          report.checks.push({ label: 'Installed virtual cable mapping', passed: false, required: true, detail: cleanError(error) }); report.available = false;
          report.guidance.unshift(suggestMappings(await navigator.mediaDevices.enumerateDevices()) ? 'Two cables were found. Press Auto-detect cables, then Use selected & test routing.' :
            native.platform === 'darwin' ? 'Fewer than two virtual cables were found. In Terminal, run "npm run setup:mac" in the app folder, then press Auto-detect cables.' :
              'Fewer than two virtual cables were found. Install two independent cables, then map them below.');
        }
      }
      if (report.available) available++;
      backendReport(report);
    }
    $('backend-progress').textContent = `Checked ${ids.length} backend${ids.length === 1 ? '' : 's'} · ${available} with required dependencies available. Use selected & test routing to verify capture and playback endpoints.`;
  } catch (error) { $('backend-progress').textContent = cleanError(error); }
  finally { setBackendBusy(false); }
}
$('backend-check').addEventListener('click', () => checkBackends(false));
$('backend-check-all').addEventListener('click', () => checkBackends(true));
$('backend-apply').addEventListener('click', async () => {
  if (backendBusy) return;
  setBackendBusy(true); cancelCheck();
  const selected = $('audio-backend').value;
  $('backend-progress').textContent = 'Applying backend and checking both audio routes…';
  try {
    await saving;
    // Reject a missing dependency before disrupting the normal audio routes.
    if (selected !== 'auto') {
      const report = await bridge.checkAudioBackend(selected); backendReport(report);
      if (!report.available) throw Error('Required dependencies are missing. Follow the backend report, then check again.');
    }
    if (selected === 'external') {
      const mappings = readMappings();
      virtualEndpoints(await navigator.mediaDevices.enumerateDevices(), { ...settings, ...mappings }, { managed: false });
      await persist(mappings);
    }
    await Promise.all(Object.values(routes).map(route => route.close()));
    native = await bridge.selectAudioBackend(selected);
    credentials = await bridge.getSettings(); settings = credentials.settings;
    await refreshAudio(true);
    const ready = routes.voice.ready && routes.listen.ready;
    $('backend-progress').textContent = ready ? 'Passed · backend saved, all virtual endpoints found and both normal audio routes connected. No audio sent to Gemini.' : 'Backend selected, but routing is incomplete. Check device access and virtual cable mapping below.';
    $('backend-progress').classList.toggle('passed', ready); $('backend-progress').classList.toggle('failed', !ready);
  } catch (error) {
    $('backend-progress').textContent = cleanError(error);
    await refreshAudio();
  } finally { setBackendBusy(false); }
});
$('auto-detect').addEventListener('click', async () => {
  const suggestion = suggestMappings(await navigator.mediaDevices.enumerateDevices());
  if (suggestion) { draftMappings = suggestion; renderDevices(); }
  $('auto-detect-status').textContent = suggestion ? 'Cables mapped. Press Use selected & test routing to save and verify.' :
    native.platform === 'darwin' ? 'Fewer than two virtual cables found. Run "npm run setup:mac", then try again.' : 'Fewer than two virtual cables found. Install two independent cables, then try again.';
  $('auto-detect-status').className = 'check-result ' + (suggestion ? 'passed' : 'failed');
});
$('driver-guide').addEventListener('click', () => bridge.openGuide(native.platform === 'win32' ? 'windows' : native.platform === 'linux' ? 'linux' : 'mac'));
bridge.onTranslation(event => routes[event.direction]?.event(event));
bridge.onRoutingChanged(() => refreshAudio());
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearTimeout(deviceTimer); deviceTimer = setTimeout(() => refreshAudio(), 350);
});
window.addEventListener('beforeunload', () => {
  disposed = true; cancelCheck(); Object.values(routes).forEach(route => route.close());
});

async function initialize() {
  credentials = await bridge.getSettings(); settings = credentials.settings;
  applyTheme(settings.theme);
  for (const direction of ['voice', 'listen']) $(direction + '-target').value = settings[direction + 'Target'];
  if (credentials.notice) notice(credentials.notice);
  native = await bridge.routingStatus();
  if (native.startupError) notice(native.startupError);
  renderRouting(); renderCredentials();
  if (native.managed && !native.ready) {
    try { native = await bridge.setupRouting(); } catch (error) { notice(cleanError(error)); }
  }
  // Obtain labels and device access once. This stream is never routed or sent.
  try {
    const listed = await navigator.mediaDevices.enumerateDevices();
    if (!listed.some(device => device.kind === 'audioinput' && device.label)) {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      permission.getTracks().forEach(track => track.stop());
    }
  } catch (error) { notice(`Microphone access is needed for normal audio routing. ${cleanError(error)}`); }
  await refreshAudio();
}
initialize().catch(error => { notice(cleanError(error)); $('setup').hidden = false; });
