// Explicit opt-in paid integration check. Synthetic speech only; no device capture.
// Usage: node tests/live-check.mjs --env ../.env
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults, validateSettings } from '../shared/settings.js';
import { GeminiSessions } from '../main/gemini.mjs';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('../test-artifacts/live/', import.meta.url));
await mkdir(directory, { recursive: true });
const envIndex = process.argv.indexOf('--env');
const environment = envIndex >= 0 ? parseEnv(await readFile(path.resolve(process.argv[envIndex + 1]), 'utf8')) : process.env;
const key = environment.GEMINI_API_KEY;
if (!key) throw Error('Set GEMINI_API_KEY or pass --env /path/to/private.env.');
const settings = validateSettings({ ...defaults, baseUrl: environment.GEMINI_BASE_URL || defaults.baseUrl });
const inputWav = path.join(directory, 'english-input.wav');
const inputPcm = path.join(directory, 'english-input.pcm');
await run('espeak-ng', ['-v', 'en-us', '-s', '145', '-w', inputWav, 'Hello. Our meeting starts tomorrow morning. Please bring your notes.']);
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputWav, '-ar', '16000', '-ac', '1', '-f', 's16le', inputPcm]);
const input = await readFile(inputPcm);
const report = { model: settings.model, input: 'Locally synthesized English speech', target: 'hi', physicalMicrophoneCaptured: false, realMeetCall: false, results: [] };
try {
  for (const direction of ['voice', 'listen']) {
    const chunks = []; let phase = '', status = '', outputRate = 24000;
    const manager = new GeminiSessions({ getCredentials: () => ({ settings, key }), emit: event => {
      if (event.type === 'state') { phase = event.phase; status = event.message; }
      if (event.type === 'audio') { chunks.push(Buffer.from(event.pcm)); outputRate = event.rate; }
    } });
    const id = `${direction}-live-check`;
    const start = Date.now();
    try {
      manager.start(direction, id);
      while (phase !== 'translating') {
        if (phase === 'normal' || Date.now() - start > 16000) throw Error(status || 'Live setup timed out.');
        await delay(50);
      }
      // Send speech and two seconds of trailing silence at real-time cadence.
      const audio = Buffer.concat([input, Buffer.alloc(64000)]);
      let sent = 0;
      for (let offset = 0; offset < audio.length; offset += 1280) {
        const frame = audio.subarray(offset, offset + 1280);
        const pcm = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
        if (manager.send(direction, id, pcm, Date.now())) sent += frame.length;
        if (phase === 'normal') throw Error(status);
        await delay(40);
      }
      await delay(2000);
      const output = Buffer.concat(chunks);
      if (output.length < 4800) throw Error('Gemini produced no usable translated audio.');
      const header = Buffer.alloc(44);
      header.write('RIFF'); header.writeUInt32LE(36 + output.length, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(outputRate, 24); header.writeUInt32LE(outputRate * 2, 28);
      header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(output.length, 40);
      await writeFile(path.join(directory, `${direction}-hindi-output.wav`), Buffer.concat([header, output]));
      const result = { direction, passed: true, inputSecondsSent: sent / 32000, outputSeconds: output.length / (outputRate * 2), elapsedMs: Date.now() - start };
      report.results.push(result); console.log(result);
    } finally { manager.stopAll(); }
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
await writeFile(path.join(directory, 'live-report.json'), JSON.stringify(report, null, 2));
if (!report.passed) console.error(report.error);
