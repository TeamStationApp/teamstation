import { expect } from 'chai'
import { makeMutable } from 'react-native-reanimated'

import { CAPSULE_TIMING, capsuleMotion } from './capsuleMotion'

async function frames(ms: number, sample: () => void): Promise<void> {
  const end = performance.now() + ms
  while (performance.now() < end) {
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => {
        resolve()
      })
    )
    sample()
  }
}

describe('capsule motion', () => {
  it('eases to a stop on a timing curve that never passes its target', () => {
    expect(CAPSULE_TIMING.duration).within(200, 300)
    const { easing } = CAPSULE_TIMING
    expect(easing(0)).equals(0)
    expect(easing(1)).closeTo(1, 1e-12)
    let previous = 0
    for (let step = 1; step <= 1000; step++) {
      const value = easing(step / 1000)
      expect(value).at.least(previous)
      expect(value).at.most(1 + 1e-12)
      previous = value
    }
    // Ease-out: it slows down as it arrives rather than swinging past.
    expect(easing(0.5)).above(0.5)
    // Progress a frame early or late stays at the ends.
    expect(easing(-0.1)).equals(0)
    expect(easing(1.2)).closeTo(1, 1e-12)
  })
  it('moves a value monotonically to its target and settles there', async () => {
    for (const [from, to] of [
      [0, 2],
      [351, 228],
      [52, 62]
    ]) {
      const value = makeMutable(from)
      value.value = capsuleMotion(to, false)
      const seen: number[] = []
      await frames(CAPSULE_TIMING.duration + 150, () => seen.push(value.value))
      expect(seen.length).above(3)
      // It passes through the values between, rather than jumping.
      expect(
        seen.filter(
          sample =>
            sample > Math.min(from, to) + 1e-3 &&
            sample < Math.max(from, to) - 1e-3
        ).length,
        String(seen)
      ).above(2)
      for (let i = 1; i < seen.length; i++)
        expect(Math.sign(seen[i] - seen[i - 1]), String(seen)).not.equals(
          Math.sign(from - to)
        )
      for (const sample of seen)
        expect(sample).within(Math.min(from, to), Math.max(from, to))
      expect(seen[seen.length - 1]).equals(to)
    }
  })
  it('jumps straight to the target under Reduce Motion', () => {
    expect(capsuleMotion(4, true)).equals(4)
  })
})
