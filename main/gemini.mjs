import WebSocket from 'ws';
import { translationSetup } from '../shared/settings.js';

// Audio and credentials stay in this process. Each direction owns one connection.
// Session IDs fence late messages when Start/Stop happens during a connection.
export class GeminiSessions {
  constructor({ getCredentials, emit, socketFactory = url => new WebSocket(url, { maxPayload: 8 * 1024 * 1024 }) }) {
    this.getCredentials = getCredentials; this.emit = emit; this.socketFactory = socketFactory;
    this.sessions = new Map();
  }
  state(session, phase, message) {
    if (this.sessions.get(session.direction) === session)
      this.emit({ type: 'state', direction: session.direction, id: session.id, phase, message });
  }
  start(direction, id) {
    if (!['voice', 'listen'].includes(direction) || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw Error('Invalid translation request.');
    this.stop(direction);
    const { settings, key } = this.getCredentials();
    if (!key) throw Error('Enter your Gemini API key in Settings.');
    const session = { direction, id, settings: { ...settings }, key, socket: null, retry: 0, ready: false, closed: false };
    this.sessions.set(direction, session);
    this.connect(session);
    return { id };
  }
  connect(session) {
    if (session.closed) return;
    this.state(session, session.retry ? 'reconnecting' : 'connecting', session.retry ? `Reconnecting (${session.retry}/3) · normal audio` : 'Connecting · normal audio');
    const url = new URL('/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', session.settings.baseUrl);
    url.protocol = 'wss:'; url.searchParams.set('key', session.key);
    let socket;
    try { socket = session.socket = this.socketFactory(url.toString()); }
    catch { this.finish(session, 'Connection failed · normal audio'); return; }
    const current = () => !session.closed && session.socket === socket;
    session.timeout = setTimeout(() => { if (current()) this.retry(session, socket, true); }, 12000);
    socket.on('open', () => {
      if (current()) socket.send(JSON.stringify(translationSetup(session.settings,
        session.direction === 'voice' ? session.settings.voiceTarget : session.settings.listenTarget)));
    });
    socket.on('message', data => {
      if (!current()) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.error) { this.finish(session, 'Gemini rejected the model, key or configuration · normal audio'); return; }
        if (message.setupComplete) {
          clearTimeout(session.timeout); session.ready = true;
          this.state(session, 'translating', 'Translating');
        }
        if (message.goAway) { this.retry(session, socket, true); return; }
        if (!session.ready) return;
        if (message.serverContent?.interrupted)
          this.emit({ type: 'clear', direction: session.direction, id: session.id });
        for (const part of message.serverContent?.modelTurn?.parts || []) {
          const audio = part.inlineData;
          if (!audio?.mimeType?.startsWith('audio/pcm') || typeof audio.data !== 'string') continue;
          const rate = Number(audio.mimeType.match(/rate=(\d+)/)?.[1] || 24000);
          if (rate < 8000 || rate > 96000 || audio.data.length > 6 * 1024 * 1024) continue;
          let bytes = Buffer.from(audio.data, 'base64');
          // Bound IPC as well as playback: retain only the freshest queue-length tail.
          const limit = Math.floor(rate * 2 * (session.settings.maxBufferMs - session.settings.playbackBufferMs) / 1000 / 2) * 2;
          if (bytes.length > limit) bytes = bytes.subarray(bytes.length - limit);
          bytes = bytes.subarray(0, bytes.length - bytes.length % 2);
          if (bytes.length) this.emit({ type: 'audio', direction: session.direction, id: session.id, rate,
            pcm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), at: Date.now() });
        }
      } catch { this.finish(session, 'Invalid Gemini response · normal audio'); }
    });
    socket.on('error', () => { if (current()) this.retry(session, socket, true); });
    socket.on('close', code => {
      if (current()) this.retry(session, socket, ![1008, 1003, 1007].includes(code));
    });
  }
  retry(session, socket, allowed) {
    if (session.closed || session.socket !== socket) return;
    clearTimeout(session.timeout); session.socket = null; session.ready = false;
    socket.terminate();
    if (!allowed || session.retry >= 3) { this.finish(session, 'Translation disconnected · normal audio. Press Start to retry.'); return; }
    session.retry++;
    this.state(session, 'reconnecting', `Reconnecting (${session.retry}/3) · normal audio`);
    session.timer = setTimeout(() => this.connect(session), 500 * 2 ** (session.retry - 1));
  }
  send(direction, id, pcm, at) {
    const session = this.sessions.get(direction);
    if (!session?.ready || session.id !== id || !(pcm instanceof ArrayBuffer) || pcm.byteLength > 6400 ||
      pcm.byteLength % 2 || !Number.isFinite(at) || Math.abs(Date.now() - at) > session.settings.maxBufferMs) return false;
    const socket = session.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    // Base64 and JSON count too: never add to an already delayed network queue.
    const limit = Math.max(4096, Math.ceil(32000 * session.settings.maxBufferMs / 1000 * 1.4));
    if (socket.bufferedAmount > limit) return false;
    socket.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    return true;
  }
  finish(session, message) { this.state(session, 'normal', message); this.stop(session.direction, session.id); }
  endInput(direction, id) {
    const session = this.sessions.get(direction);
    if (!session?.ready || session.id !== id || session.socket?.readyState !== WebSocket.OPEN) return false;
    session.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    return true;
  }
  stop(direction, id) {
    const session = this.sessions.get(direction);
    if (!session || (id && session.id !== id)) return;
    session.closed = true; session.ready = false; session.key = '';
    clearTimeout(session.timeout); clearTimeout(session.timer);
    session.socket?.terminate(); this.sessions.delete(direction);
  }
  stopAll() { for (const direction of [...this.sessions.keys()]) this.stop(direction); }
}
