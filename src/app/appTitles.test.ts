import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

/**
 * The header says as little as it can get away with.
 *
 * It used to say `TEAMSTATION` and then the name of the screen underneath,
 * which on the home screen meant reading the name of the app twice on a screen
 * that already has the mark in the corner. Now: the mark on home only, the
 * screen's name centred where there is one, and nothing at all where the
 * content below says it better.
 */
describe('app titles', function () {
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
  const header = readFileSync(
    join(__dirname, 'components/AppHeader.tsx'),
    'utf8'
  )

  it('names the home screen after the screen, not the app', function () {
    expect(source).contains("return 'Your Home'")
    expect(source).not.contains("if (tab === 'home') return 'TeamStation'")
  })

  it('has no overline anywhere, and no way to pass one', function () {
    expect(source).not.contains('overline')
    expect(header).not.contains('overline')
  })

  it('shows the mark on a tab, and not on a pushed screen', function () {
    expect(source).contains('showMark={top == null}')
    // Off unless a screen asks, so a new screen inherits no chrome.
    expect(header).contains('showMark = false')
  })

  it('left-justifies the title beside the mark', function () {
    // The one line everything else in the app is aligned to.
    expect(header).not.contains("textAlign: 'center'")
    expect(header).not.contains('styles.middle')
  })

  it('gives the back chevron a target the height of the header', function () {
    expect(header).contains('size={2.5}')
    expect(header).match(/back: \{[\s\S]*?minWidth: theme\.rem\(3\)/)
    expect(header).match(/back: \{[\s\S]*?minHeight: theme\.rem\(3\)/)
  })

  it('has three destinations, and Account is not one of them', function () {
    // Read rather than imported: the component pulls in React Native, which
    // does not load outside a bundler, and the list is the thing being
    // asserted rather than the rendering of it.
    const nav = readFileSync(join(__dirname, 'components/AppNav.tsx'), 'utf8')
    expect(nav).contains(
      "export type NavTabId = 'home' | 'videos' | 'schedule'"
    )
    expect(nav).not.contains("id: 'account'")
  })

  it('draws the destinations as icons alone', function () {
    const nav = readFileSync(join(__dirname, 'components/AppNav.tsx'), 'utf8')
    // The label is what a screen reader says, not what is painted.
    expect(nav).contains('accessibilityLabel={tab.label}')
    expect(nav).not.contains('<Text')
  })

  it('hands the game card up as the card itself goes under', function () {
    const game = readFileSync(join(__dirname, 'screens/GameScreen.tsx'), 'utf8')
    // Watch and the other sections now delegate measurement to pinned bands.
    expect(game).contains('head={scoreboard}')
    expect(game).contains(
      '<CardBand part={pinned.cardBand}>{scoreboard}</CardBand>'
    )
    for (const layout of [
      'GameWatchLayout.tsx',
      'GameWatchLayout.native.tsx'
    ]) {
      const source = readFileSync(join(__dirname, 'screens', layout), 'utf8')
      expect(source).match(
        /ref=\{pinned\.cardBand\.ref\}[\s\S]*?onLayout=\{pinned\.cardBand\.handleLayout\}[\s\S]*?\{short \? null : head\}/
      )
      // The pills have their own measured band, after the card's band.
      expect(source.indexOf('{short ? null : head}')).lessThan(
        source.indexOf('ref={pinned.pillBand.ref}')
      )
    }
  })

  it('keeps the pane keyed, so a breakpoint cannot remount the player', function () {
    expect(source).contains('key="pane"')
    expect(source).contains('key="nav"')
  })

  it('reaches Account by pushing it, from the header', function () {
    expect(source).contains("push({ name: 'account' })")
  })
})
