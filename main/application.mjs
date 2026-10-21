import { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, powerSaveBlocker, protocol, safeStorage, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SettingsStore } from './store.mjs';
import { AudioBackends } from './backends.mjs';
import { GeminiSessions } from './gemini.mjs';
import { HealthChecks } from './health.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = 'app://gemini/renderer/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true
} }]);

// Dependency injection is used by the separate desktop test harness, never by
// production environment flags or a renderer-accessible switch.
export async function launch({ userData, socketFactory, beforeWindow, show = true } = {}) {
  if (userData) app.setPath('userData', userData);
  await app.whenReady();
  const store = new SettingsStore(app.getPath('userData'), safeStorage);
  await store.load();
  nativeTheme.themeSource = store.settings.theme;
  const routing = new AudioBackends(app.getPath('userData'), { getSettings: () => store.settings });
  if (beforeWindow) await beforeWindow({ store, routing });
  let window;
  const sessions = new GeminiSessions({ getCredentials: () => ({ settings: store.settings, key: store.key }),
    emit: event => { if (window && !window.isDestroyed()) window.webContents.send('translation:event', event); }, socketFactory });
  const health = new HealthChecks({ getCredentials: () => ({ settings: store.settings, key: store.key }), socketFactory });
  let startupError = '';

  protocol.handle('app', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'gemini' || !/^\/(renderer|shared)\/[a-zA-Z0-9/_-]+\.(html|css|js|svg|png)$/.test(url.pathname))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(root, url.pathname)).toString());
  });
  const trusted = contents => contents && window && contents.id === window.webContents.id;
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    trusted(contents) && origin.startsWith('app://gemini') &&
    (permission === 'speaker-selection' || (permission === 'media' && details.mediaType !== 'video')));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(trusted(contents) && details.requestingUrl?.startsWith(home) &&
      (permission === 'speaker-selection' || (permission === 'media' && details.mediaTypes?.every(type => type === 'audio')))));
  });
  session.defaultSession.setDevicePermissionHandler(details =>
    details.origin === 'app://gemini' && details.deviceType === 'audio');

  function authorize(event) {
    if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== home)
      throw Error('Untrusted application request.');
  }
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { authorize(event); return fn(...args); });
  let writes = Promise.resolve();
  handle('settings:get', () => store.public());
  handle('settings:save', (settings, key) => {
    const task = writes.then(async () => {
      const result = await store.save(settings, key);
      nativeTheme.themeSource = store.settings.theme;
      return result;
    }); writes = task.catch(() => {}); return task;
  });
  handle('settings:forget', () => {
    sessions.stopAll(); health.cancel();
    const task = writes.then(() => store.forget()); writes = task.catch(() => {}); return task;
  });
  handle('routing:status', async () => {
    const status = await routing.status();
    return { ...status, ...(startupError && status.managed ? { ready: false, message: startupError } : {}), startupError };
  });
  handle('routing:setup', async () => {
    const result = await routing.setup(); if (result.ready) startupError = ''; return result;
  });
  handle('routing:probe', id => routing.probe(id));
  handle('routing:select', id => {
    const task = writes.then(async () => {
      sessions.stopAll(); health.cancel();
      const result = await routing.select(id);
      await store.save({ ...store.settings, audioBackend: id });
      startupError = '';
      return result;
    }); writes = task.catch(() => {}); return task;
  });
  handle('routing:remove', () => { sessions.stopAll(); return routing.remove(); });
  handle('health:check', (kind, direction, patch, key) => health.run(kind, direction, patch, key));
  handle('health:cancel', () => health.cancel());
  handle('translation:start', (direction, id) => sessions.start(direction, id));
  handle('translation:stop', (direction, id) => sessions.stop(direction, id));
  ipcMain.on('translation:pcm', (event, direction, id, pcm, at) => {
    try { authorize(event); sessions.send(direction, id, pcm, at); } catch { /* Reject malformed or late frames. */ }
  });
  const guides = {
    windows: 'https://vb-audio.com/Cable/',
    mac: 'https://existential.audio/blackhole/',
    linux: 'https://docs.pipewire.org/page_man_pactl_1.html'
  };
  handle('guide:open', platform => { if (Object.hasOwn(guides, platform)) return shell.openExternal(guides[platform]); });

  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 820, height: 940, minWidth: 600, minHeight: 700, show: false,
    title: 'Gemini Audio', backgroundColor: nativeTheme.shouldUseDarkColors ? '#111923' : '#f4f6f8', icon: path.join(root, 'assets/icon.png'),
    webPreferences: { preload: path.join(root, 'main/preload.cjs'), sandbox: true,
      nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, spellcheck: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== home) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => { sessions.stopAll(); app.quit(); });
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  const stopWatching = routing.watch(() => {
    if (!window.isDestroyed()) window.webContents.send('routing:changed');
  });
  let quitting = false, canExit = false;
  app.on('before-quit', event => {
    if (canExit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true; sessions.stopAll(); health.cancel(); stopWatching();
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    // Await setup too, so quitting during a repair does not leak new modules.
    routing.remove().catch(() => {}).finally(() => { canExit = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
  process.once('SIGTERM', () => app.quit());
  process.once('SIGINT', () => app.quit());
  try { await routing.reset(); } catch (error) { startupError = error.message; }
  if (quitting) return { window, store, routing, sessions };
  await window.loadURL(home);
  if (show) window.show();
  return { window, store, routing, sessions };
}
