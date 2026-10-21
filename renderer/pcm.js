// Reused from ../src/core.ts: phase is preserved across AudioWorklet blocks.
export class Resampler {
  constructor(rate, chunkSamples = 640) {
    this.ratio = rate / 16000; this.size = chunkSamples;
    this.sum = 0; this.weight = 0; this.chunk = [];
  }
  push(input) {
    const out = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          this.chunk.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.ratio)) * 32767));
          this.weight = 0; this.sum = 0;
          if (this.chunk.length === this.size) {
            const buffer = new ArrayBuffer(this.size * 2);
            const view = new DataView(buffer);
            this.chunk.forEach((value, index) => view.setInt16(index * 2, value, true));
            out.push(buffer); this.chunk = [];
          }
        }
      }
    }
    return out;
  }
}

export function playbackPlan(now, next, duration, bufferMs, maxMs) {
  const delay = bufferMs / 1000;
  const overflow = Math.max(now + delay, next) + duration - now > maxMs / 1000;
  const start = overflow ? now + delay : Math.max(now + delay, next);
  const offset = Math.max(0, duration - (maxMs - bufferMs) / 1000);
  return { overflow, start, offset, end: start + duration - offset };
}
