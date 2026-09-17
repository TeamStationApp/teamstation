import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

/**
 * The header says the app's name on one line and the screen's name on the
 * other. It used to say `GAMESTATION` over `GameStation` on the home screen,
 * which is the app's name twice and the screen's name nowhere.
 */
describe('app titles', function () {
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

  it('names the home screen after the screen, not the app', function () {
    expect(source).contains("return 'Your Home'")
    expect(source).not.contains("if (tab === 'home') return 'GameStation'")
  })

  it('keeps the overline on a pushed screen too', function () {
    expect(source).contains('overline="GameStation"')
    expect(source).not.contains("top == null ? 'GameStation' : undefined")
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

  it('reaches Account by pushing it, from the header', function () {
    expect(source).contains("push({ name: 'account' })")
  })
})
