import { expect } from 'chai'
import { describe, it } from 'mocha'

import { renderFixture, spawnEncoder } from './renderFixture'

/**
 * The fixture renderer against a real child process in ffmpeg's place: it
 * stops writing when the encoder goes, rather than waiting for a drain.
 */
describe('a synthetic camera fixture, with a real encoder process', function () {
  it('stops writing when ffmpeg goes, and says how it ended', async function () {
    // A program that exits at once with 3, in ffmpeg's place.
    const encoder = spawnEncoder(process.execPath, ['-e', 'process.exit(3)'])
    const frames = await renderFixture(
      { label: 'SynthA', minutes: 1, out: 'x', ffmpeg: 'ff' },
      () => encoder
    ).catch((error: unknown) => (error as Error).message)
    expect(frames).equals('ffmpeg exited with 3')
    expect(await spawnEncoder('/no/such/ffmpeg', []).exited).equals(null)
  })
})
