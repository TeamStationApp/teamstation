import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { FieldNameplates, useFieldNameplates } from './NativeNameplates'
import type { NameplatePlacement } from './playerPresentation'

let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

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

describe('the phone’s nameplates over the field', function () {
  it('draws empty position squares with the same red appearance and acronym', async function () {
    let report: ((plates: NameplatePlacement[]) => void) | undefined
    function Harness(): React.ReactElement {
      const nameplates = useFieldNameplates()
      report = nameplates.report
      return (
        <FieldNameplates faces={nameplates.faces} spots={nameplates.spots} />
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Harness />)
    })
    await act(async () => {
      report?.([
        plate('empty-P', {
          emptyPosition: true,
          name: 'P',
          number: '',
          width: 40,
          height: 40,
          anchorY: 0.5
        })
      ])
      await delay(30)
    })
    const node = document.querySelector<HTMLElement>('[aria-label="Assign P"]')!
    expect(node.textContent).equals('P')
    expect(getComputedStyle(node).width).equals('40px')
    expect(getComputedStyle(node).height).equals('40px')
    expect(getComputedStyle(node).borderStyle).equals('dashed')
    expect(getComputedStyle(node).backgroundColor).equals(
      'rgba(255, 190, 190, 0.22)'
    )
  })
  it('draws what the scene reports, and moves it without rendering again', async function () {
    let report: ((plates: NameplatePlacement[]) => void) | undefined
    let renders = 0
    function Harness(): React.ReactElement {
      renders++
      const nameplates = useFieldNameplates()
      report = nameplates.report
      return (
        <FieldNameplates faces={nameplates.faces} spots={nameplates.spots} />
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<Harness />)
    })
    const plates = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="field-nameplate"]'
        )
      )
    expect(plates()).has.length(0)
    await act(async () => {
      report?.([
        plate('SS'),
        plate('r1', { team: 'runner', uniformSide: 'away', number: '' })
      ])
      await delay(30)
    })
    expect(plates().map(node => node.textContent)).deep.equals([
      'Name SS#7',
      'Name r1'
    ])
    const settled = renders
    const style = (node: HTMLElement): CSSStyleDeclaration =>
      getComputedStyle(node)
    expect(style(plates()[0]).transform).contains('translateX(100px)')
    // iOS recycles native views and never moves or sizes one whose layout is
    // an empty frame at the origin, so a plate's moving view is never that:
    // it kept the place of the view it was recycled from.
    for (const node of plates()) {
      expect(style(node).width).equals('1px')
      expect(style(node).height).equals('1px')
    }
    // The next frame moves one and hides the other: no React render.
    await act(async () => {
      report?.([
        plate('SS', { x: 140, y: 210 }),
        plate('r1', {
          team: 'runner',
          uniformSide: 'away',
          number: '',
          visible: false
        })
      ])
      await delay(30)
    })
    expect(renders).equals(settled)
    expect(style(plates()[0]).transform).contains('translateX(140px)')
    expect(style(plates()[1]).opacity).equals('0')
    // Taking the ball changes what the plate says: that renders.
    await act(async () => {
      report?.([plate('SS', { name: '⚾ Name SS' })])
      await delay(30)
    })
    expect(renders).equals(settled + 1)
    expect(plates().map(node => node.textContent)).deep.equals(['⚾ Name SS#7'])
  })
})
