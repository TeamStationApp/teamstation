import { expect } from 'chai'
import { describe, it } from 'mocha'

import { expandMasks } from './visual'

describe('masks for maestro-d', function () {
  const drawn = async (css: string): Promise<number[]> =>
    css === '.tile' ? [0, 2, 3] : []

  it('stands a mask marked every for each drawn element it matches, by index', async function () {
    expect(
      await expandMasks([{ css: '.tile', every: true }], drawn)
    ).deep.equals([
      { css: '.tile', index: '0' },
      { css: '.tile', index: '2' },
      { css: '.tile', index: '3' }
    ])
  })

  it('masks nothing for an every mask with nothing drawn, and passes every other mask as it is', async function () {
    expect(
      await expandMasks(
        [{ css: '.gone', every: true }, { css: '.card' }, { id: 'clock' }],
        drawn
      )
    ).deep.equals([{ css: '.card' }, { id: 'clock' }])
  })

  it('passes an every mask as one entry where it cannot count, as on a phone', async function () {
    expect(await expandMasks([{ css: '.tile', every: true }])).deep.equals([
      { css: '.tile' }
    ])
  })
})
