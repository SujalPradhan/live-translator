import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateSettings } from '../shared/settings.js';
import { GeminiSessions } from './gemini.mjs';

export class HealthChecks {
  constructor({ getCredentials, socketFactory, samplePath = new URL('../assets/check-speech.pcm', import.meta.url) }) {
    this.getCredentials = getCredentials; this.socketFactory = socketFactory; this.samplePath = samplePath;
  }
  cancel() { this.active?.abort(); }
  async run(kind, direction = 'voice', patch = {}, keyDraft) {
    if (this.active) return { ok: false, message: 'Another check is running. Wait or cancel it first.' };
    if (!['connection', 'sample'].includes(kind) || !['voice', 'listen'].includes(direction))
      return { ok: false, message: 'Invalid health check.' };
    const controller = this.active = new AbortController();
    try {
      const stored = this.getCredentials();
      const settings = validateSettings({ ...stored.settings, model: patch.model ?? stored.settings.model, baseUrl: patch.baseUrl ?? stored.settings.baseUrl });
      if (keyDraft !== undefined && (typeof keyDraft !== 'string' || keyDraft.length > 4096)) throw Error('Invalid API key.');
      const key = keyDraft?.trim() || stored.key;
      if (!key) throw Error('Enter your Gemini API key in Settings.');
      const sample = kind === 'sample' ? await readFile(this.samplePath) : null;
      return await this.perform({ kind, direction, settings, key, sample, signal: controller.signal });
    } catch (error) { return { ok: false, message: error.message }; }
    finally { if (this.active === controller) this.active = null; }
  }
  perform({ kind, direction, settings, key, sample, signal }) {
    return new Promise(resolve => {
      let finished = false, pumping = false, inputDone = 0, lastOutput = 0, seconds = 0, timeout, tick;
      const audio = [], id = `health-${randomUUID()}`;
      const finish = result => {
        if (finished) return;
        finished = true; clearTimeout(timeout); clearInterval(tick);
        signal.removeEventListener('abort', cancel); manager.stopAll();
        resolve({ ...result, checkedAt: Date.now() });
      };
      const cancel = () => finish({ ok: false, cancelled: true, message: 'Check cancelled.' });
      const pump = async () => {
        pumping = true;
        // Short fixed speech followed by silence, with the real framing settings.
        const input = Buffer.concat([sample, Buffer.alloc(48000)]);
        const size = settings.chunkMs * 32;
        try {
          for (let offset = 0; offset < input.length && !finished; offset += size) {
            const frame = input.subarray(offset, offset + size);
            if (!manager.send(direction, id, frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength), Date.now()))
              throw Error('Audio could not be sent. Check your connection and retry.');
            await delay(settings.chunkMs, undefined, { signal });
          }
          inputDone = Date.now();
          if (!finished) manager.endInput(direction, id);
        } catch (error) { if (!finished) finish({ ok: false, message: signal.aborted ? 'Check cancelled.' : error.message }); }
      };
      const manager = new GeminiSessions({ getCredentials: () => ({ settings, key }), socketFactory: this.socketFactory,
        emit: event => {
          if (finished) return;
          if (event.type === 'state') {
            if (event.phase === 'translating') {
              if (kind === 'connection') finish({ ok: true, message: 'Connected. Gemini accepted your key, model and translation settings.' });
              else if (!pumping) void pump();
            } else if (['normal', 'reconnecting'].includes(event.phase)) finish({ ok: false, message: event.message });
          }
          if (event.type === 'audio' && kind === 'sample') {
            seconds += event.pcm.byteLength / (event.rate * 2);
            if (seconds > 30) { finish({ ok: false, message: 'Unexpectedly long test audio. Check stopped.' }); return; }
            audio.push({ pcm: event.pcm, rate: event.rate }); lastOutput = Date.now();
          }
        } });
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      timeout = setTimeout(() => finish({ ok: false, message: kind === 'connection' ? 'Connection check timed out.' : 'No translated audio received. Check your model, language and connection.' }), kind === 'connection' ? 14000 : 25000);
      tick = setInterval(() => {
        // Some translation sessions keep emitting background/silence audio.
        // A finite sample must finish even when the stream never becomes quiet.
        if (inputDone && audio.length && (Date.now() - lastOutput > 900 || Date.now() - inputDone > 5000))
          finish({ ok: true, message: `Translation received (${seconds.toFixed(1)} seconds).`, seconds, audio });
        else if (inputDone && !audio.length && Date.now() - inputDone > 7000)
          finish({ ok: false, message: 'Connected, but Gemini returned no translated audio.' });
      }, 100);
      try { manager.start(direction, id); } catch (error) { finish({ ok: false, message: error.message }); }
    });
  }
}
