/* global AudioWorkletProcessor, registerProcessor, sampleRate */

/**
 * The web microphone's AudioWorklet processor (`microphone.ts`), which runs
 * on the audio thread: it averages the context's own `sampleRate` down to
 * 16 kHz mono 16-bit PCM and posts about a tenth of a second at a time.
 *
 * A file of its own, served from the page's origin, because the page's
 * Content-Security-Policy (`script-src 'self'`) refuses a worklet built from
 * a `blob:` or `data:` URL. `src/build.mjs` copies it verbatim to
 * `dist/pcm16kWorklet.js` (`WORKLET_URL`), in one-shot builds and under
 * `--serve` alike; `microphone.test.ts` runs this same file.
 */

const PCM_RATE = 16000

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / PCM_RATE
    this.sum = 0
    this.count = 0
    this.step = 0
    this.out = new Int16Array(PCM_RATE / 10)
    this.length = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel == null) return true
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i]
      this.count++
      this.step++
      if (this.step < this.ratio) continue
      this.step -= this.ratio
      const sample = Math.max(-1, Math.min(1, this.sum / this.count))
      this.out[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.sum = 0
      this.count = 0
      if (this.length === this.out.length) {
        const chunk = this.out.slice(0, this.length)
        this.port.postMessage(chunk.buffer, [chunk.buffer])
        this.length = 0
      }
    }
    return true
  }
}

registerProcessor('pcm16k', Pcm16k)
