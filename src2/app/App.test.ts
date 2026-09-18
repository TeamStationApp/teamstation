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
 * The invariant is that the layout is one tree whose axis changes. Rendering
 * the app at two widths and comparing node identity would state that
 * directly, but needs a React renderer this project does not carry — and the
 * mistake has a reliable fingerprint: the same component written twice, once
 * per arrangement. That is what this looks for.
 */
describe('app layout', function () {
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

  it('renders the navigation exactly once, whatever the width', function () {
    const uses = source.match(/<AppNav\b/g) ?? []
    expect(uses.length, 'AppNav is written once, in one tree').equals(1)
  })

  it('changes the axis rather than the arrangement', function () {
    expect(source).contains('column-reverse')
    expect(source).contains('isRail ? styles.appRow : styles.appColumn')
  })
})
