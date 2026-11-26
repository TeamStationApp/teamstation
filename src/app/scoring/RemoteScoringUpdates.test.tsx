import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act } from 'react'

import { canBlur, glassStyle } from '../components/glass'
import { getTheme } from '../theme/ThemeContext'
import {
  fixture,
  host,
  panel,
  render,
  tap,
  unmount
} from './remoteScoringFixture.test'
import { scoringPreferences } from './scoringPreferences'
describe('remote scoring update panel', () => {
  it("shows a remote scorer's named spans and never the viewer's own", async () => {
    const f = fixture()
    await render(f.game)
    await f.update('own', 'remote-panel-test', [{ type: 'pitch', call: 'B' }])
    expect(panel()).equals(null)
    await f.update('peer', 'other', [{ type: 'pitch', call: 'C' }])
    expect(
      host.querySelector('[data-testid="remote-scoring-update-lines"]')!
        .textContent
    ).equals('Mike T.: Called strike')
  })
  it('credits alternating scorers within one at-bat with a row each', async () => {
    const f = fixture()
    await render(f.game)
    await f.update('a1', 'other', [{ type: 'pitch', call: 'B' }])
    await f.update('a2', 'other', [{ type: 'pitch', call: 'B' }])
    await f.update('b1', 'other-b', [{ type: 'pitch', call: 'C' }])
    const rows = [
      ...host.querySelectorAll<HTMLElement>(
        '[data-testid="remote-scoring-update-lines"] > * > *'
      )
    ].map(row => row.textContent)
    expect(rows).deep.equals(['Mike T.: Ball, ball', 'Mike T.: Called strike'])
  })
  it("shows a remote Undo in the client's words, but not one made before it opened", async () => {
    const f = fixture()
    await f.update('early', 'other', [{ type: 'pitch', call: 'B' }])
    await f.undo(1, 'other', false)
    await render(f.game)
    expect(panel()).equals(null)
    await f.update('again', 'other', [{ type: 'pitch', call: 'C' }])
    await f.undo(1, 'other')
    expect(panel()!.textContent).contains('Mike T.: Undo — Called strike')
    expect(panel()!.textContent).not.contains('Undo — Ball')
  })
  it('does not reopen dismissed content when later remote work arrives', async () => {
    const f = fixture()
    await render(f.game)
    await f.update('a', 'other', [{ type: 'pitch', call: 'B' }])
    await f.undo(1, 'other')
    expect(panel()!.textContent).contains('Undo — Ball')
    await tap('Dismiss scoring updates')
    await f.echo()
    expect(panel()).equals(null)
    await f.update('b', 'other', [{ type: 'pitch', call: 'C' }])
    expect(
      host.querySelector('[data-testid="remote-scoring-update-lines"]')!
        .textContent
    ).equals('Mike T.: Called strike')
  })
  it('keeps every row when a reload rebuilds unchanged actions', async () => {
    const f = fixture()
    await render(f.game)
    await f.update('a', 'other', [{ type: 'pitch', call: 'B' }])
    const text = panel()!.textContent
    await f.reread()
    expect(panel()!.textContent).equals(text)
  })
  it('keeps collecting while zero lines fit and displays the new rows after resize', async () => {
    const f = fixture()
    await render(f.game, 'short-screen', 0)
    await f.update('pitch')
    expect(panel()).equals(null)
    await render(f.game, 'short-screen', 1)
    expect(panel()!.textContent).contains('Mike T.')
  })
  for (const lines of [1, 3, 5]) {
    it(`draws a 44-point header above ${lines} log lines at the frame origin`, async () => {
      const f = fixture()
      await render(f.game, 'frame-test', lines, false, 410)
      await f.update('pitch')
      const body = host.querySelector<HTMLElement>(
        '[data-testid="remote-scoring-update-lines"]'
      )!
      expect(body.style.height).equals(`${lines * 20}px`)
      expect(panel()!.style.top).equals('410px')
      expect(panel()!.style.left).equals('12px')
      await tap('Collapse scoring updates')
      expect(panel()!.style.top).equals('410px')
      await tap('Expand scoring updates')
    })
  }
  it('updates a named play in place and keeps its pitch sequence separate from the outcome', async () => {
    const f = fixture(true)
    await render(f.game, 'summary-test')
    await f.update('pitch-one', 'other', [{ type: 'pitch', call: 'B' }])
    await f.update('pitch-two', 'other', [{ type: 'pitch', call: 'B' }])
    expect(panel()!.textContent).contains('Ball, ball')
    expect(panel()!.textContent!.match(/Mike T\.:/g)).has.length(1)
    await f.update('single', 'other', [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'single' }
    ])
    expect(panel()!.textContent, panel()!.textContent ?? '')
      .contains('Player 1 single')
      .and.not.contains('after ball')
    expect(panel()!.textContent!.match(/Mike T\.:/g)).has.length(2)
    await tap('Dismiss scoring updates')
    await f.echo()
    expect(panel()).equals(null)
  })
  it('resumes following when a menu unmounts a paused log', async () => {
    const f = fixture()
    await render(f.game)
    await f.update('first')
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    Object.defineProperties(lines, {
      scrollHeight: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 100 }
    })
    for (const y of [400, 100])
      await act(async () => {
        lines.scrollTop = y
        lines.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 120))
      })
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).not.equals(null)
    await render(f.game, 'remote-panel-test', 5, true)
    await render(f.game)
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).equals(null)
  })
  it('resumes following when a paused log is collapsed and reopened', async () => {
    const f = fixture()
    await render(f.game)
    await f.update('first')
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    Object.defineProperties(lines, {
      scrollHeight: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 100 }
    })
    for (const y of [400, 100])
      await act(async () => {
        lines.scrollTop = y
        lines.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 120))
      })
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).not.equals(null)
    await tap('Collapse scoring updates')
    await tap('Expand scoring updates')
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).equals(null)
  })
  it('resumes through the down-chevron after the reader pauses', async () => {
    const f = fixture()
    await render(f.game, 'tap-follow-test')
    await f.update('first')
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    Object.defineProperties(lines, {
      scrollHeight: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 100 }
    })
    for (const y of [400, 150])
      await act(async () => {
        lines.scrollTop = y
        lines.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 120))
      })
    await tap('Follow latest scoring updates')
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).equals(null)
    await f.update('resumed')
    expect(
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    ).equals(null)
  })
  it('resumes following and hides the chevron when manually scrolled to the bottom', async () => {
    const f = fixture()
    await render(f.game, 'manual-follow-test')
    await f.update('first')
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    Object.defineProperties(lines, {
      scrollHeight: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 100 }
    })
    const scrollTo = async (y: number): Promise<void> => {
      await act(async () => {
        lines.scrollTop = y
        lines.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 120))
      })
    }
    const resume = (): Element | null =>
      host.querySelector('[aria-label="Follow latest scoring updates"]')
    const content = lines.firstElementChild as HTMLElement
    const rightPadding = getComputedStyle(content).paddingRight
    await scrollTo(400)
    await scrollTo(200)
    expect(resume()).not.equals(null)
    expect(getComputedStyle(content).paddingRight).equals(rightPadding)
    expect(
      host.querySelector('[data-testid="remote-scoring-follow-blur"]')
    ).not.equals(null)
    await f.update('while-paused')
    expect(resume()).not.equals(null)
    await scrollTo(350)
    expect(resume()).not.equals(null)
    await scrollTo(399.5)
    expect(resume()).equals(null)
    await f.update('after-resuming')
    expect(resume()).equals(null)
    await scrollTo(150)
    expect(resume()).not.equals(null)
  })
  it('keeps the taller log fixed, clears the catcher and uses dictation yellow', async () => {
    const f = fixture()
    await render(f.game, 'five-lines-test')
    await f.update('first')
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    expect(lines.style.height).equals('100px')
    expect(Number.parseFloat(panel()!.style.top)).equals(280)
    const author = [...lines.querySelectorAll<HTMLElement>('*')].find(
      element => element.textContent === 'Mike T.: '
    )!
    const color = document.createElement('span')
    color.style.color = getTheme().scoringCountdownColor
    expect(author.style.color).equals(color.style.color)
    await f.update('second')
    expect(lines.style.height).equals('100px')
  })
  it('retains only 50 logical lines and renders compact yellow author prefixes', async () => {
    const f = fixture()
    await render(f.game, 'retention-test')
    for (let i = 0; i < 30; i++) await f.update(String(i))
    expect(panel()!.textContent!.match(/Mike T\.:/g)).has.length(50)
    expect(panel()!.textContent).not.contains('Top 1:')
    expect(panel()!.style.zIndex).equals('10')
    const controls = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-controls"]'
    )!
    expect(controls.style.position).equals('relative')
    expect(controls.style.top).equals('0px')
    for (const id of [
      'remote-scoring-collapse-blur',
      'remote-scoring-dismiss-blur'
    ]) {
      const blur = host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
      expect(getComputedStyle(blur).borderTopLeftRadius).equals('8px')
      const expected = document.createElement('span')
      expected.style.backgroundColor = canBlur
        ? ''
        : String(glassStyle(getTheme()).backgroundColor)
      expect(blur.style.backgroundColor).equals(expected.style.backgroundColor)
    }
  })
  it('yields to scoring menus without losing updates or the collapse preference', async () => {
    const f = fixture()
    await render(f.game, 'overlay-test')
    await f.update('first')
    expect(panel()).not.equals(null)
    await render(f.game, 'overlay-test', 5, true)
    expect(panel()).equals(null)
    await f.update('during-menu')
    expect(panel()).equals(null)
    await render(f.game, 'overlay-test')
    expect(panel()!.textContent!.match(/Mike T\./g)).has.length(4)
    await tap('Collapse scoring updates')
    await render(f.game, 'overlay-test', 5, true)
    await f.update('during-sheet')
    await render(f.game, 'overlay-test')
    expect(
      host.querySelector('[aria-label="Expand scoring updates"]')
    ).not.equals(null)
  })
  it('ignores initial history, own acknowledgments and duplicate delivery, but shows named remote plays and Undo', async () => {
    const f = fixture()
    await f.update('initial')
    await render(f.game)
    expect(panel()).equals(null)
    await f.update('own', 'remote-panel-test')
    expect(panel()).equals(null)
    await f.update('peer')
    expect(panel()!.textContent)
      .contains('Mike T.')
      .and.contains('Undo — Called strike')
    await tap('Dismiss scoring updates')
    await f.echo()
    expect(panel()).equals(null)
    await f.update('next')
    expect(panel()).not.equals(null)
  })
  it('remembers collapse across dismissal, new updates and remounts', async () => {
    const f = fixture()
    await render(f.game, 'collapse-test')
    await f.update('1')
    await tap('Collapse scoring updates')
    expect(panel()!.style.width).equals('96px')
    expect(panel()!.textContent).not.contains('Top 1')
    await tap('Dismiss scoring updates')
    await f.update('2')
    expect(
      host.querySelector('[aria-label="Expand scoring updates"]')
    ).not.equals(null)
    expect(
      (await scoringPreferences.read('collapse-test')).remoteUpdatesCollapsed
    ).equals(true)
    await tap('Expand scoring updates')
    await tap('Dismiss scoring updates')
    await f.update('3')
    expect(
      host.querySelector('[aria-label="Collapse scoring updates"]')
    ).not.equals(null)
    await tap('Collapse scoring updates')
    await unmount()
    await render(f.game, 'collapse-test')
    await f.update('4')
    expect(
      host.querySelector('[aria-label="Expand scoring updates"]')
    ).not.equals(null)
  })
  it('clears history on game/account changes and keeps the expanded height fixed', async () => {
    const f = fixture()
    await render(f.game, 'scroller-test', 5)
    for (let i = 0; i < 6; i++) await f.update(String(i))
    const lines = host.querySelector<HTMLElement>(
      '[data-testid="remote-scoring-update-lines"]'
    )!
    expect(Number.parseFloat(lines.style.height)).equals(100)
    expect(panel()!.style.width).equals('369px')
    expect(Number.parseFloat(panel()!.style.top)).at.most(400 - 64)
    await render(f.game, 'another-account')
    expect(panel()).equals(null)
    const other = fixture()
    await render(other.game, 'another-account')
    await f.update('old-game')
    expect(panel()).equals(null)
    await other.update('new-game')
    expect(panel()).not.equals(null)
  })
})
