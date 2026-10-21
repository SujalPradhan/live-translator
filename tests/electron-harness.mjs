import { app } from 'electron';
import WebSocket from 'ws';
import { launch } from '../main/application.mjs';
import { defaults } from '../shared/settings.js';

app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
launch({
  userData: process.env.GEMINI_TEST_USER_DATA,
  show: true,
  socketFactory: () => new WebSocket(`ws://127.0.0.1:${process.env.GEMINI_TEST_WS_PORT}`),
  beforeWindow: async ({ store, routing }) => {
    await store.save({ ...defaults, audioBackend: process.env.GEMINI_TEST_NATIVE_PIPEWIRE === '1' ? 'pipewire' : 'auto' }, 'test-only-key');
    if (process.env.GEMINI_TEST_NO_PACTL === '1') {
      const run = routing.run;
      routing.run = async (command, ...args) => {
        if (command === 'pactl') throw Object.assign(Error('pactl unavailable in test'), { code: 'ENOENT' });
        return run(command, ...args);
      };
      routing.backends.pulse.run = routing.run;
    }
    const status = routing.status.bind(routing);
    routing.status = async () => {
      const result = await status();
      for (const device of result.devices || []) {
        device.isDefault = /^(fixture_mic|fixture_output)$/.test(device.nativeId);
        if (device.isDefault) device.isVirtual = false;
        if (device.nativeId === 'fixture_mic_alt') device.isVirtual = false;
      }
      return result;
    };
  }
}).catch(error => { console.error(error.message); app.exit(1); });
