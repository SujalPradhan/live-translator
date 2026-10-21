import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { HealthChecks } from '../main/health.mjs';
import { defaults } from '../shared/settings.js';

async function fixture(t, onMessage) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const messages = [];
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); messages.push(message); onMessage(socket, message);
  }));
  const health = new HealthChecks({ getCredentials: () => ({ settings: defaults, key: 'saved-test-key' }),
    socketFactory: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`) });
  t.after(async () => { health.cancel(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { health, messages, server };
}

test('connection health uses draft values, accepts setup and sends zero audio', async t => {
  const { health, messages } = await fixture(t, (socket, message) => {
    if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
  });
  const result = await health.run('connection', 'voice', { model: 'custom-live-translate' }, 'draft-test-key');
  assert.equal(result.ok, true);
  assert.equal(messages[0].setup.model, 'models/custom-live-translate');
  assert.equal(messages.some(message => message.realtimeInput), false);
  assert.equal(health.active, null);
});

test('connection rejection reports failure without exposing credentials', async t => {
  const { health } = await fixture(t, socket => socket.send(JSON.stringify({ error: { code: 400 } })));
  const result = await health.run('connection');
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('saved-test-key'));
});

test('health cancellation closes the socket and permits a new check', async t => {
  const { health } = await fixture(t, () => {});
  const pending = health.run('connection');
  health.cancel();
  assert.equal((await pending).cancelled, true);
  assert.equal(health.active, null);
  const retry = health.run('connection'); health.cancel();
  assert.equal((await retry).cancelled, true);
});

test('sample check streams fixed PCM in its own target language and returns bounded playable audio', async t => {
  let background;
  t.after(() => clearInterval(background));
  const { health, messages } = await fixture(t, (socket, message) => {
    if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    const output = () => socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: {
      mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(1920, 1).toString('base64')
    } }] } } }));
    if (message.realtimeInput?.audio) output();
    // Continuous background output must not keep a finite check alive forever.
    if (message.realtimeInput?.audioStreamEnd) {
      background = setInterval(output, 100); socket.once('close', () => clearInterval(background));
    }
  });
  const result = await health.run('sample', 'listen');
  assert.equal(result.ok, true); assert.ok(result.seconds > 0);
  assert.equal(messages[0].setup.generationConfig.translationConfig.targetLanguageCode, 'hi');
  assert.ok(messages.some(message => message.realtimeInput?.audioStreamEnd === true));
  assert.ok(result.audio.every(chunk => chunk.pcm instanceof ArrayBuffer && chunk.rate === 24000));
  assert.equal(health.active, null);
});
