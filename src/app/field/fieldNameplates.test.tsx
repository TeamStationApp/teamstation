import { expect } from 'chai'
import { describe, it } from 'mocha'

import { syncFieldNameplates } from './fieldNameplates'
import type { NameplatePlacement } from './playerPresentation'

const plate = (
  id: string,
  extra: Partial<NameplatePlacement> = {}
): NameplatePlacement => ({
  id,
  name: `Name ${id}`,
  number: '#7',
  team: 'defense',
  uniformSide: 'home',
  x: 100,
  y: 200,
  anchorX: 0.5,
  anchorY: 1,
  width: 60,
  height: 30,
  visible: true,
  ...extra
})

describe('the browser’s nameplates', function () {
  it('keeps one plate per player, updated in place, and drops the rest', function () {
    const host = document.createElement('div')
    syncFieldNameplates(host, [plate('SS'), plate('LF', { number: '' })])
    const node = (id: string): HTMLElement =>
      host.querySelector(`[data-nameplate="${id}"]`)!
    expect(host.children).has.length(2)
    expect(node('SS').textContent).equals('Name SS#7')
    expect(node('SS').style.left).equals('100px')
    expect(node('SS').style.transform).equals('translate(-50%, -100%)')
    expect(node('SS').style.backgroundColor).equals('rgba(122, 48, 16, 0.94)')
    expect(node('LF').textContent).equals('Name LF')
    const first = node('SS')
    syncFieldNameplates(host, [
      plate('SS', { x: 140, number: '', visible: false })
    ])
    expect(host.children).has.length(1)
    expect(node('SS')).equals(first)
    expect(node('SS').style.left).equals('140px')
    expect(node('SS').textContent).equals('Name SS')
    expect(node('SS').style.visibility).equals('hidden')
  })
})
