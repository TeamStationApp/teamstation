import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

/**
 * Crossing a breakpoint must not rebuild the tree.
 *
 * `App` used to return one tree for the rail and another for the bottom bar.
 * React reconciles children by position, so crossing 1024px put an
 * `AppHeader` where an `AppNav` had been, unmounted everything under it, and
 * took the playing `<video>` with it: dragging a browser window across that
 * width stopped the video dead.
 *
 * The invariant is that a breakpoint may change styles, and may change where a
 * stateless thing is drawn, but may not change the position of the tree above
 * something stateful. The navigation moves between the header and a floating
 * capsule, which is allowed because it holds nothing; the pane holding the body
 * is rendered once, unconditionally, and keyed, so React matches it to itself
 * across the change instead of matching it against whatever used to be first.
 *
 * Rendering the app at two widths and comparing node identity would state that
 * directly, but needs a React renderer this project does not carry — and the
 * mistake has a reliable fingerprint in the source.
 */
describe('app layout', function () {
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

  it('renders the body exactly once, whatever the width', function () {
    const uses = source.match(/\{body\}/g) ?? []
    expect(uses.length, 'the body is written once, in one tree').equals(1)
  })

  it('keys both children of the root, so neither can take the other s place', function () {
    expect(source).contains('key="pane"')
    expect(source).contains('key="nav"')
  })

  it('renders the pane unconditionally', function () {
    // Inside a branch it could be unmounted by a width change, which is
    // exactly the bug this file exists for.
    expect(source).match(/<View key="pane" style={styles\.pane}>/)
  })

  it('draws the header over the content rather than above it', function () {
    // Glass needs something behind it to blur, so the content runs the full
    // height of the window and clears the header with padding instead.
    expect(source).contains('styles.headerLayer')
    expect(source).contains('<HeaderSlotProvider')
    const screen = readFileSync(
      join(__dirname, 'components/Screen.tsx'),
      'utf8'
    )
    // One measured number, read from the slot rather than copied.
    expect(screen).contains('paddingTop: headerHeight')
    // The event page does not go through Screen. Its web layout has to ask
    // for the same inset, or the hero starts under the glass header.
    const watch = readFileSync(
      join(__dirname, 'screens/GameWatchLayout.tsx'),
      'utf8'
    )
    expect(watch).contains('paddingTop: headerHeight')
  })
})

/**
 * U28: DJ Game's address. It is wired like Score Game — a screen of its own
 * on the tab's stack — but a browser has no music to play, so on the web
 * the same address draws the game screen instead.
 */
describe('DJ Game in the shell', function () {
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

  it('stacks the DJ Game route on its tab, and reads it back off the top', function () {
    expect(source).contains(
      "if (route.name === 'djGame') return { [tab]: [route] }"
    )
    expect(source).contains(
      "if (top.name === 'djGame') return { name: 'djGame', gameId: top.gameId }"
    )
  })

  it('draws DJ Game only on an iPhone, and the game screen otherwise', function () {
    const phone = source.indexOf(
      "top.name === 'djGame' && walkUpMusic.djSupported ? ("
    )
    const web = source.indexOf("top.name === 'djGame' ? (")
    expect(phone).greaterThan(0)
    expect(web).greaterThan(phone)
    expect(source.slice(phone, web)).contains('<DjGameScreen')
    // A new game is a new instance, so its walk-up songs are got ready too.
    expect(source.slice(phone, web)).contains('key={top.gameId}')
    const next = source.indexOf(') : top.name', web)
    expect(source.slice(web, next)).contains('<GameScreen')
    expect(source.slice(web, next)).not.contains('<DjGameScreen')
  })

  it('mounts DJ Game afresh for each game', function () {
    expect(source).match(/<DjGameScreen[^>]*?key=\{top\.gameId\}/)
  })

  it('is not immersive: the header and the tabs stay', function () {
    const immersive = source.slice(
      source.indexOf('const immersiveField ='),
      source.indexOf('return (', source.indexOf('const immersiveField ='))
    )
    expect(immersive).match(/top\?\.name === 'scoreGame'/)
    expect(immersive).not.includes('djGame')
  })
})
