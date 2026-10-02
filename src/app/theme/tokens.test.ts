import { expect } from 'chai'
import { readdirSync, readFileSync, statSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

import { tsBallpark } from './tsBallpark'
import { tsDark } from './tsDark'

/**
 * Every theme token is a `string`, so nothing stops a background colour being
 * used as a text colour. That is not a hypothetical: four styles on the game
 * screen drew their text in `clearButtonColor`, which is `transparent` in the
 * theme the app actually runs, so a highlight's timecode and the whole of the
 * box score's column headings were invisible. Nobody reported it, because
 * invisible text looks like a layout choice.
 *
 * A type cannot catch this — `transparent` is a perfectly good string. A test
 * that reads the source can, so this one does.
 */

/** Tokens that name a surface, and so can never be a foreground colour. */
function isSurface(token: string): boolean {
  return token.endsWith('Background') || token.endsWith('BackgroundColor')
}

/** `primaryButtonColor` is the button's fill. `buttonTextColor` is not. */
function isButtonFill(token: string): boolean {
  return token.endsWith('ButtonColor')
}

const FOREGROUND =
  /\b(?:color|textDecorationColor|placeholderTextColor|tintColor):\s*theme\.([A-Za-z0-9_]+)/g

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(path)
    }
  }
  return found
}

describe('theme tokens', function () {
  it('never paints text with a surface or a button fill', function () {
    const offences: string[] = []

    for (const path of sourceFiles(join(__dirname, '..'))) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(FOREGROUND)) {
        const token = match[1]
        if (token == null) continue
        if (!isSurface(token) && !isButtonFill(token)) continue
        const line = source.slice(0, match.index).split('\n').length
        offences.push(`${path.split('/app/')[1]}:${line} uses ${token}`)
      }
    }

    expect(offences, offences.join('\n')).deep.equals([])
  })

  it("gives both themes the mark's two gradient colours as hex", function () {
    for (const theme of [tsBallpark, tsDark]) {
      expect(theme.markGradientStart).match(/^#[0-9A-Fa-f]{6}$/)
      expect(theme.markGradientEnd).match(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
