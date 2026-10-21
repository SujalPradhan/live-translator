import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { GeminiSessions } from '../main/gemini.mjs';
import { defaults } from '../shared/settings.js';

async function waitFor(condition, timeout = 3000) {
  const start = Date.now();
  while (!condition()) { if (Date.now() - start > timeout) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, onMessage) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  server.on('connection', socket => socket.on('message', data => onMessage(socket, JSON.parse(data.toString()))));
  const events = [];
  const manager = new GeminiSessions({ getCredentials: () => ({ settings: defaults, key: 'test-key' }),
    emit: event => events.push(event), socketFactory: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`) });
  t.after(async () => { manager.stopAll(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { manager, events, server };
}

test('both directions connect independently; stopping one rejects late frames and leaves the other running', async t => {
  const received = [];
  const { manager, events } = await fixture(t, (socket, message) => {
    if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
    else { received.push(message); socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] } } })); }
  });
  manager.start('voice', 'voice-session-1'); manager.start('listen', 'listen-session-1');
  await waitFor(() => events.filter(event => event.phase === 'translating').length === 2);
  assert.equal(manager.send('voice', 'voice-session-1', new ArrayBuffer(1280), Date.now()), true);
  assert.equal(manager.send('listen', 'listen-session-1', new ArrayBuffer(1280), Date.now()), true);
  await waitFor(() => events.filter(event => event.type === 'audio').length === 2);
  manager.stop('voice', 'voice-session-1');
  assert.equal(manager.send('voice', 'voice-session-1', new ArrayBuffer(1280), Date.now()), false);
  assert.equal(manager.sessions.get('listen').ready, true);
  assert.equal(received.length, 2);
  manager.start('voice', 'voice-session-2');
  manager.stop('voice', 'voice-session-1'); // stale Stop cannot cancel the new session
  assert.equal(manager.sessions.get('voice').id, 'voice-session-2');
});

test('Stop during setup never emits translated audio or reconnects', async t => {
  let connected;
  const { manager, events } = await fixture(t, socket => { connected = socket; });
  manager.start('voice', 'voice-session-1'); await waitFor(() => connected);
  manager.stop('voice');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(events.some(event => event.phase === 'translating'), false);
  assert.equal(manager.sessions.size, 0);
});

test('stale input is dropped and oversized Gemini output is bounded before IPC', async t => {
  const { manager, events } = await fixture(t, (socket, message) => {
    if (message.setup) {
      socket.send(JSON.stringify({ setupComplete: {} }));
      socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(240000).toString('base64') } }] } } }));
    }
  });
  manager.start('voice', 'voice-session-1'); await waitFor(() => events.some(event => event.type === 'audio'));
  const output = events.find(event => event.type === 'audio');
  assert.ok(output.pcm.byteLength <= 24000 * 2 * 1.44);
  assert.equal(manager.send('voice', 'voice-session-1', new ArrayBuffer(1280), Date.now() - 10000), false);
});

test('connection loss restores normal mode and Stop cancels scheduled reconnect', async t => {
  const { manager, events } = await fixture(t, (socket, message) => {
    if (message.setup) { socket.send(JSON.stringify({ setupComplete: {} })); setTimeout(() => socket.close(1011), 20); }
  });
  manager.start('listen', 'listen-session-1');
  await waitFor(() => events.some(event => event.phase === 'reconnecting'));
  manager.stop('listen'); const count = events.length;
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(events.length, count); assert.equal(manager.sessions.size, 0);
});
