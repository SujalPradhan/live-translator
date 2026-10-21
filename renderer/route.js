import { playbackPlan } from './pcm.js';

export class AudioRoute {
  constructor(direction, bridge, update) {
    this.direction = direction; this.bridge = bridge; this.update = update;
    this.phase = 'normal'; this.id = null; this.epoch = 0;
    this.sources = new Set(); this.next = 0; this.lastSound = 0;
  }
  get translating() { return Boolean(this.id); }
  get ready() { return Boolean(this.context && this.stream?.active); }
  announce(message) { this.update({ phase: this.phase, message, translating: this.translating, ready: this.ready }); }
  async configure(stream, sink, settings) {
    await this.close();
    const epoch = ++this.epoch;
    this.stream = stream; this.settings = { ...settings };
    try {
      const context = this.context = new AudioContext({ latencyHint: 'interactive' });
      // Set a concrete sink before connecting anything. Never fall back to a
      // virtual OS default, which could feed this route back into itself.
      await context.setSinkId(sink);
      this.sinkId = sink;
      if (epoch !== this.epoch) return;
      await context.audioWorklet.addModule(new URL('./capture.js', import.meta.url));
      if (epoch !== this.epoch) return;
      this.original = context.createGain(); this.original.gain.value = 1;
      this.original.connect(context.destination);
      this.dub = context.createGain(); this.dub.connect(context.destination);
      this.source = context.createMediaStreamSource(stream); this.source.connect(this.original);
      this.capture = new AudioWorkletNode(context, 'capture', { processorOptions: { chunkMs: settings.chunkMs } });
      const zero = context.createGain(); zero.gain.value = 0;
      this.source.connect(this.capture); this.capture.connect(zero).connect(context.destination);
      this.capture.port.onmessage = event => this.input(event.data);
      await context.resume();
      if (epoch !== this.epoch) return;
      this.heartbeat = setInterval(() => {
        if (this.phase === 'translating' && this.settings.silenceSeconds > 0 &&
          performance.now() - this.lastSound > this.settings.silenceSeconds * 1000)
          this.stop('Silence timeout · normal audio');
      }, 200);
      this.announce('Normal audio · untranslated');
    } catch (error) { await this.close(); throw error; }
  }
  input({ pcm, capturedAt }) {
    if (!this.id || this.phase !== 'translating') return;
    const age = Math.max(0, (this.context.currentTime - capturedAt) * 1000);
    if (age > this.settings.maxBufferMs) return;
    const view = new DataView(pcm);
    for (let i = 0; i < view.byteLength; i += 2) {
      if (Math.abs(view.getInt16(i, true)) > 250) { this.lastSound = performance.now(); break; }
    }
    this.bridge.sendAudio(this.direction, this.id, pcm, Date.now() - age);
  }
  async start(settings) {
    if (!this.ready) throw Error('Connect your audio devices first.');
    if (this.id) return;
    this.settings = { ...settings };
    this.capture.port.postMessage({ chunkMs: settings.chunkMs });
    this.lastSound = performance.now(); this.phase = 'connecting';
    const id = this.id = crypto.randomUUID();
    this.announce('Connecting · normal audio');
    try { await this.bridge.startTranslation(this.direction, id); }
    catch (error) { if (this.id === id) this.stop(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
  }
  stop(message = 'Normal audio · untranslated') {
    const id = this.id; this.id = null; this.phase = 'normal';
    // Restore bypass synchronously; waiting for IPC would introduce a silent gap.
    if (this.original && this.context && this.context.state !== 'closed') this.original.gain.setValueAtTime(1, this.context.currentTime);
    this.clear();
    if (id) this.bridge.stopTranslation(this.direction, id).catch(() => {});
    this.announce(message);
  }
  event(event) {
    if (!this.id || event.id !== this.id || event.direction !== this.direction) return;
    if (event.type === 'clear') this.clear();
    if (event.type === 'state') {
      if (event.phase === 'normal') { this.stop(event.message); return; }
      this.phase = event.phase;
      const active = this.phase === 'translating';
      this.original.gain.setValueAtTime(active ? 0 : 1, this.context.currentTime);
      if (!active) this.clear();
      else this.lastSound = performance.now();
      this.announce(event.message);
    }
    if (event.type === 'audio' && this.phase === 'translating' &&
      Date.now() - event.at <= this.settings.maxBufferMs) this.play(event.pcm, event.rate);
  }
  play(pcm, rate) {
    const context = this.context;
    if (!context || !pcm.byteLength) return;
    const view = new DataView(pcm);
    const buffer = context.createBuffer(1, Math.floor(pcm.byteLength / 2), rate);
    const floats = buffer.getChannelData(0);
    for (let i = 0; i < floats.length; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
    const plan = playbackPlan(context.currentTime, this.next, buffer.duration,
      this.settings.playbackBufferMs, this.settings.maxBufferMs);
    if (plan.overflow) this.clear();
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.dub);
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(plan.start, plan.offset); this.next = plan.end;
  }
  clear() {
    for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch {} }
    this.sources.clear(); this.next = 0;
  }
  async close() {
    ++this.epoch; this.stop(); clearInterval(this.heartbeat);
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = null;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.port.close(); this.capture.disconnect(); }
    this.source?.disconnect(); this.original?.disconnect(); this.dub?.disconnect();
    this.source = null; this.original = null; this.dub = null;
    const context = this.context; this.context = null; this.capture = null; this.sinkId = null;
    this.announce('Connecting audio…');
    if (context && context.state !== 'closed') await context.close();
  }
}
