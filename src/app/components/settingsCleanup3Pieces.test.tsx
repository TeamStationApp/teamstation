import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'

import { mount, press, unmount } from '../../test/gameFormDom'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { AddEventCard } from './AddEventCard'
import { Button } from './Button'
import { CancelAction } from './CancelAction'
import { Emblem } from './Emblem'
import { FittedInitials } from './FittedInitials'
import { initialsFontSize } from './initialsFit'
import { SettingsGear } from './SettingsGear'
import { TeamEmblem } from './TeamEmblem'
import { TEAM_TINTS, teamTint } from './teamTile'

function leaf(value: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>('*')].find(
    node => node.children.length === 0 && node.textContent === value
  )!
}
function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
}
describe('settings cleanup shared presentation', () => {
  afterEach(unmount)
  it('opens the gear once from a full-size non-shrinking target', async () => {
    let calls = 0
    await mount(
      <SettingsGear
        label="League settings"
        onPress={() => {
          calls++
        }}
      />
    )
    await press('League settings')
    expect(calls).equals(1)
    const button = document.querySelector<HTMLElement>(
      '[aria-label="League settings"]'
    )!
    expect(getComputedStyle(button).width).equals('48px')
    expect(getComputedStyle(button).height).equals('48px')
    expect(getComputedStyle(button).flexShrink).equals('0')
  })
  it('keeps Add Event blue, bold, borderless and centered with a shadow', async () => {
    let calls = 0
    await mount(
      <AddEventCard
        onPress={() => {
          calls++
        }}
      />
    )
    await press('Add Event')
    expect(calls).equals(1)
    const card = document.querySelector<HTMLElement>(
      '[data-testid="add-event-card"]'
    )!
    expect(getComputedStyle(card).backgroundColor).equals(
      rgb(tsBallpark.addEventCardColor)
    )
    expect(getComputedStyle(card).borderTopStyle).not.equals('dashed')
    expect(getComputedStyle(card).boxShadow).not.equals('none')
    expect(getComputedStyle(leaf('Add Event')).fontWeight).equals('700')
    for (const theme of [tsBallpark, tsDark]) {
      const luminance = (hex: string): number =>
        [1, 3, 5]
          .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const values = [
        luminance(theme.addEventCardColor),
        luminance(theme.addEventCardTextColor)
      ].sort((a, b) => a - b)
      expect((values[1] + 0.05) / (values[0] + 0.05)).at.least(4.5)
    }
  })
  for (const destructive of [true, false])
    it(`centers Cancel and uses the ${destructive ? 'blue' : 'red'} contextual color without writing`, async () => {
      let calls = 0
      await mount(
        <CancelAction
          destructivePrimary={destructive}
          disabled
          onPress={() => {
            calls++
          }}
        />
      )
      await press('Cancel')
      expect(calls).equals(0)
      const label = leaf('Cancel')
      expect(getComputedStyle(label).color).equals(
        rgb(destructive ? tsBallpark.linkTextColor : tsBallpark.dangerColor)
      )
      expect(getComputedStyle(label.parentElement!).alignSelf).equals('center')
      await unmount()
      await mount(
        <CancelAction
          label="Dismiss"
          accessibilityLabel="Cancel dialog"
          onPress={() => {
            calls++
          }}
        />
      )
      await press('Cancel dialog')
      expect(calls).equals(1)
    })
  it('uses one trimmed name for team initials/color with a readable empty-name fallback', async () => {
    await mount(
      <>
        <TeamEmblem name=" Winter Wolves " />
        <TeamEmblem name="" />
        <Emblem fallback="WW" />
      </>
    )
    expect(getComputedStyle(leaf('WW').parentElement!).backgroundColor).equals(
      rgb(teamTint('Winter Wolves'))
    )
    expect(leaf('T')).not.equals(undefined)
    expect(new Set(TEAM_TINTS).size).equals(32)
    const colors = new Set(
      Array.from({ length: 4096 }, (_, i) => teamTint(`Team ${i}`))
    )
    expect(colors.size).equals(32)
  })
  it('falls back after an expired image and loads a changed URI on the same emblem', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'Image')!
    const images: HTMLImageElement[] = []
    const OriginalImage = window.Image
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: function Image() {
        const image = new OriginalImage()
        Object.defineProperty(image, 'naturalWidth', { value: 32 })
        Object.defineProperty(image, 'naturalHeight', { value: 32 })
        images.push(image)
        return image
      }
    })
    function Harness(): React.ReactElement {
      const [uri, setUri] = useState('https://images.example.test/expired.png')
      return (
        <>
          <TeamEmblem name="Winter Wolves" uri={uri} />
          <Button
            label="New photo"
            onPress={() => {
              setUri('https://images.example.test/replacement.png')
            }}
          />
        </>
      )
    }
    try {
      await mount(<Harness />)
      await act(async () => {
        for (const image of images)
          image.dispatchEvent(new window.Event('error'))
      })
      expect(leaf('WW')).not.equals(undefined)
      expect(
        getComputedStyle(leaf('WW').parentElement!).backgroundColor
      ).equals(rgb(teamTint('Winter Wolves')))
      await press('New photo')
      expect(document.body.innerHTML).includes('replacement.png')
      expect(
        [...document.querySelectorAll('*')].some(
          node => node.children.length === 0 && node.textContent === 'WW'
        )
      ).equals(false)
      await act(async () => {
        for (const image of images) {
          Object.defineProperty(image, 'naturalWidth', { value: 32 })
          Object.defineProperty(image, 'naturalHeight', { value: 32 })
          image.dispatchEvent(new window.Event('load'))
        }
      })
      expect(document.body.innerHTML).includes('replacement.png')
    } finally {
      Object.defineProperty(window, 'Image', descriptor)
    }
  })
  it('fits wide, narrow, single and Unicode glyph metrics proportionally', () => {
    for (const [width, height] of [
      [190, 72],
      [70, 72],
      [24, 72],
      [112, 92]
    ]) {
      const size = initialsFontSize(100, width, height, 100)
      expect((width * size) / 100).at.most(80.000001)
      expect((height * size) / 100).at.most(80.000001)
      expect(Math.max((width * size) / 100, (height * size) / 100)).closeTo(
        80,
        0.000001
      )
    }
    expect(initialsFontSize(100, 0, 0, 0)).equals(40)
  })
  it('recomputes preview sizing after a name change and keeps ordinary emblems small', async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'getContext'
    )!
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: '',
      measureText: (letters: string) => ({
        width: letters === 'WW' ? 190 : 70,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: letters === 'WW' ? 190 : 70,
        actualBoundingBoxAscent: 72,
        actualBoundingBoxDescent: 0
      })
    })) as unknown as HTMLCanvasElement['getContext']
    try {
      await mount(<FittedInitials letters="WW" size={6} color="#FFFFFF" />)
      expect(parseFloat(getComputedStyle(leaf('WW')).fontSize))
        .greaterThan(35)
        .and.lessThan(45)
      await unmount()
      await mount(
        <>
          <FittedInitials letters="W" size={6} color="#FFFFFF" />
          <Emblem fallback="AG" />
        </>
      )
      expect(parseFloat(getComputedStyle(leaf('W')).fontSize)).greaterThan(100)
      expect(getComputedStyle(leaf('AG')).fontSize).equals('16px')
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', original)
    }
  })
})
