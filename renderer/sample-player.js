// Diagnostic audio is played only on the selected physical listening device.
// It never enters GeminiMic or either translation input graph.
export class SamplePlayer {
  async play(chunks, sink) {
    this.stop();
    if (!sink || ['default', 'communications'].includes(sink)) throw Error('Select a connected physical listening device.');
    const context = this.context = new AudioContext({ latencyHint: 'interactive' });
    try {
      await context.setSinkId(sink);
      if (this.context !== context) return false;
      await context.resume();
      if (this.context !== context) return false;
      return await new Promise(resolve => {
        this.finish = resolve; this.sources = [];
        let next = context.currentTime + 0.06;
        chunks.forEach((chunk, index) => {
          const view = new DataView(chunk.pcm);
          const buffer = context.createBuffer(1, view.byteLength / 2, chunk.rate);
          const output = buffer.getChannelData(0);
          for (let i = 0; i < output.length; i++) output[i] = view.getInt16(i * 2, true) / 32768;
          const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
          if (index === chunks.length - 1) source.onended = () => this.stop(true);
          this.sources.push(source); source.start(next); next += buffer.duration;
        });
        if (!chunks.length) this.stop(false);
      });
    } catch (error) { this.stop(); throw error; }
  }
  stop(completed = false) {
    for (const source of this.sources || []) { source.onended = null; try { source.stop(); source.disconnect(); } catch {} }
    this.sources = [];
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') void context.close();
    const finish = this.finish; this.finish = null; finish?.(completed);
  }
}
