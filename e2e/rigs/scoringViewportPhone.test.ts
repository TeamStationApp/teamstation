import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { MaestroDevice } from '../core/maestro'
import { nativeFooterRows } from './scoringViewportPhone'

describe('web viewport screenshot calibration', function () {
  for (const [
    direction,
    width,
    height,
    nativeMenuY,
    visible,
    screenshot,
    expected
  ] of [
    ['portrait', 393, 852, 67, 695, { width: 1178, height: 2556 }, 100],
    ['landscape', 852, 393, 118, 283, { width: 2556, height: 1178 }, 0]
  ] as const) {
    it(
      'samples only the native bottom band in Safari ' + direction,
      async function () {
        const tree = {
          type: 'Application',
          bounds: { x: 0, y: 0, width, height },
          children: [
            {
              text: 'Open scoring menu',
              bounds: { x: 0, y: nativeMenuY, width: 48, height: 48 }
            }
          ]
        }
        const phone: Pick<MaestroDevice, 'hierarchy'> = {
          hierarchy: async () => tree
        }
        expect(
          await nativeFooterRows(phone, screenshot, {
            width,
            top: 0,
            bottom: visible,
            menu: { top: 8, height: 48 }
          })
        ).equals(expected)
      }
    )
  }
})
