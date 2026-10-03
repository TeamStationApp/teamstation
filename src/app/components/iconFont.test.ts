import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

import { iconCodepoints } from './iconCodepoints'

/**
 * The phone font is a subset. A name added to `IconName` and not rebuilt into
 * it draws as the word itself, which is how the dictation button showed
 * "MIC" across the control.
 */
describe('the phone icon font', function () {
  const source = readFileSync(join(__dirname, 'Icon.tsx'), 'utf8')
  const block = /export type IconName =([\s\S]*?)\n\n/.exec(source)
  const names =
    block == null
      ? []
      : [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1])
  const font = readFileSync(
    join(__dirname, '../assets/fonts/MaterialSymbolsOutlined.ttf')
  ).toString('latin1')

  it('carries a glyph for every icon the app names, including the microphone', function () {
    expect(names).includes('mic')
    expect(names).includes('mic_off')
    const seen = new Set<number>()
    for (const name of names) {
      const stored = String.fromCharCode(name.length) + name
      expect(font.includes(stored), name).equals(true)
      const codepoint = iconCodepoints[name as keyof typeof iconCodepoints]
      expect(codepoint, name).to.be.a('number')
      expect(seen.has(codepoint), name).equals(false)
      seen.add(codepoint)
    }
  })
})
