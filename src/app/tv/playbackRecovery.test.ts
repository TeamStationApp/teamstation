import { expect } from 'chai'
import { describe, it } from 'mocha'

import { PlaybackRecovery } from './playbackRecovery'

describe('TV per-camera playback recovery', () => {
  it('lets a slow native replacement finish, but bounds an attempt that never opens', () => {
    const watch = new PlaybackRecovery(0)
    watch.error(100)
    expect(watch.retry(1100, false, false)).equals(true)
    watch.opening(1100)
    for (let now = 2100; now < 31100; now += 1000)
      expect(watch.retry(now, false, false)).equals(false)
    expect(watch.retry(31100, false, false)).equals(true)
    watch.opening(31100)
    watch.progress(10, 55100)
    watch.progress(10.25, 55350)
    expect(watch.retry(56000, true, false)).equals(false)
    expect(watch.retry(75350, true, false)).equals(true)
  })
  it('gives a buffering camera two minutes between transfers, and a silent one twenty seconds', () => {
    const watch = new PlaybackRecovery(0)
    watch.progress(10, 0)
    watch.progress(10.25, 250)
    watch.buffer(true, 5000)
    expect(watch.retry(30_000, true, false), 'downloading').equals(false)
    watch.transfer(100_000)
    expect(watch.retry(219_999, true, false)).equals(false)
    expect(watch.retry(220_000, true, false), 'no transfer').equals(true)
    const ready = new PlaybackRecovery(0)
    ready.buffer(true, 0)
    ready.buffer(false, 1000)
    ready.transfer(15_000) // A transfer is no picture while not buffering.
    expect(ready.retry(21_000, true, false)).equals(true)
  })
  it('does not let a camera flipping in and out of buffering hide a stall', () => {
    const watch = new PlaybackRecovery(0)
    watch.progress(10, 0)
    watch.progress(10.25, 250)
    watch.buffer(true, 500)
    let fired: number | null = null
    for (let now = 1000; now <= 130_000 && fired === null; now += 1000) {
      if (now % 3000 === 0) watch.buffer(now % 6000 === 0, now)
      if (watch.retry(now, true, false)) fired = now
    }
    expect(fired).not.equals(null)
    expect(fired!).lessThanOrEqual(121_000)
  })
  it('still exhausts a camera whose every remount lands later and stalls', () => {
    const watch = new PlaybackRecovery(0)
    watch.progress(10, 0)
    watch.progress(10.25, 250)
    watch.error(1000)
    let landing = 40
    for (let now = 2000; now <= 320_000 && !watch.exhausted; now += 1000) {
      if (watch.retry(now, true, false)) {
        watch.opening(now)
        // The remount lands at the moment the game has reached, then sticks.
        watch.progress(landing, now + 500)
        watch.progress(landing + 0.003, now + 750)
        landing += 30
      }
    }
    expect(watch.exhausted).equals(true)
  })
  it('retries a replacement error without waiting out its opening deadline', () => {
    const watch = new PlaybackRecovery(0)
    watch.error(100)
    expect(watch.retry(1100, false, false)).equals(true)
    watch.opening(1100)
    watch.error(1500)
    expect(watch.retry(3100, false, false)).equals(true)
    watch.opening(3100)
    watch.readyPaused(3500)
    expect(watch.retry(25000, false, false)).equals(false)
  })
  it('keeps the total retry budget bounded even while a decoder is opening', () => {
    const watch = new PlaybackRecovery(0)
    watch.error(100)
    expect(watch.retry(299000, false, false)).equals(true)
    watch.opening(299000)
    expect(watch.retry(300100, false, false)).equals(false)
    expect(watch.exhausted).equals(true)
  })
  it('retries errors while paused, backs off, and bounds a silent failure', () => {
    const watch = new PlaybackRecovery(0)
    watch.error(100)
    expect(watch.retry(100, false, false)).equals(false)
    expect(watch.retry(1100, false, false)).equals(true)
    expect(watch.retry(1101, false, false)).equals(false)
    expect(watch.retry(3100, false, false)).equals(true)
    expect(watch.retry(300100, false, false)).equals(false)
    expect(watch.exhausted).equals(true)
    expect(watch.retry(310000, true, false)).equals(false)
  })
  it('ignores an ordinary pause and ending, but detects a silent stalled player', () => {
    const watch = new PlaybackRecovery(0)
    expect(watch.retry(100000, false, false)).equals(false)
    expect(watch.retry(110000, true, false)).equals(false)
    expect(watch.retry(120000, true, true)).equals(false)
    expect(watch.retry(120000, true, false)).equals(true)
  })
  it('accepts a successfully reloaded paused frame without inventing playback', () => {
    const watch = new PlaybackRecovery(0)
    watch.error(100)
    expect(watch.retry(1100, false, false)).equals(true)
    watch.readyPaused(1200)
    expect(watch.retry(40000, false, false)).equals(false)
    expect(watch.retry(40001, true, false)).equals(false)
    expect(watch.retry(60000, true, false)).equals(true)
  })
  it('requires advancement, rather than repeated ready or position reports, to recover', () => {
    const watch = new PlaybackRecovery(0)
    watch.progress(10, 1000)
    watch.progress(10, 19000)
    expect(watch.retry(20000, true, false)).equals(true)
    watch.error(20001)
    watch.progress(10, 21000)
    expect(watch.retry(22000, true, false)).equals(true)
    watch.progress(10.5, 22001)
    expect(watch.retry(23000, true, false)).equals(false)
    expect(watch.retry(42001, true, false)).equals(true)
    watch.retry(342001, true, false)
    watch.progress(11, 342002)
    expect(watch.exhausted).equals(false)
  })
})
