import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fonts as web } from './fonts'
import { fonts } from './fonts.native'

describe('the fonts a phone draws with', function () {
  it('are the families the app carries, never a system font', function () {
    expect(fonts).deep.equals({
      spaceGrotesk: 'Space Grotesk',
      quicksand: 'Quicksand',
      inter: 'Inter',
      materialSymbols: 'Material Symbols Outlined'
    })
  })

  it('are the web’s families, each first in its stack, and no named system font', function () {
    expect(Object.keys(web).sort()).deep.equals(Object.keys(fonts).sort())
    for (const [name, stack] of Object.entries(web)) {
      const [first, ...rest] = stack.split(',').map(one => one.trim())
      expect(first.replace(/"/g, ''), stack).equals(
        fonts[name as keyof typeof fonts]
      )
      // Only the generic family, for a file that failed to arrive.
      for (const fallback of rest) expect(fallback, stack).equals('sans-serif')
      expect(stack, stack).not.match(/system|BlinkMac|Segoe|Arial|Helvetica/i)
    }
  })
})
