import { Resampler } from './pcm.js';

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.frame = options.processorOptions.chunkMs;
    this.resampler = new Resampler(sampleRate, 16 * this.frame);
    this.port.onmessage = event => {
      if (event.data.chunkMs) this.resampler = new Resampler(sampleRate, 16 * event.data.chunkMs);
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      for (const buffer of this.resampler.push(mono)) this.port.postMessage({ pcm: buffer, capturedAt: currentTime }, [buffer]);
    }
    return true;
  }
}
registerProcessor('capture', Capture);
