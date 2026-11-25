import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Image } from 'react-native'

import { mount, settle, unmount } from '../../test/gameFormDom'
import { coverRect } from './coverRect'
import { openSponsorUrl } from './openSponsorUrl'
import { SponsoredScheduleRow, TEXT_COLORS } from './SponsoredScheduleRow'

afterEach(async () => {
  await unmount()
})

const ROW = {
  logoUrl: 'https://example.test/logo.png',
  backgroundUrl: 'https://example.test/background.png',
  title: 'Bayside Bakery',
  message: 'Fresh bread for every team after the game.',
  url: 'https://example.test/bread'
}

describe('U33 a sponsored Schedule row', () => {
  it('covers a wide container with its background anchored upper-right', () => {
    // A 1920 × 224 strip in a 1000 × 112 row: scaled to the row's width.
    const wide = coverRect(
      { width: 1000, height: 112 },
      { width: 1920, height: 224 }
    )
    expect(wide.y).equals(0)
    expect(wide.x + wide.w).closeTo(1000, 1e-9)
    expect(wide.w).closeTo(1000, 1e-9)
    expect(wide.h).closeTo(1000 * (224 / 1920), 1e-9)
  })

  it('covers a narrow container from the upper-right corner, cutting the left', () => {
    const narrow = coverRect(
      { width: 360, height: 112 },
      { width: 1920, height: 224 }
    )
    expect(narrow.h).closeTo(112, 1e-9)
    expect(narrow.w).closeTo(960, 1e-9)
    expect(narrow.x).closeTo(360 - 960, 1e-9)
    expect(narrow.y).equals(0)
    const centred = coverRect(
      { width: 360, height: 112 },
      { width: 1920, height: 224 },
      'center'
    )
    expect(centred.x).closeTo((360 - 960) / 2, 1e-9)
  })

  it('fills the container while either size is unknown', () => {
    expect(
      coverRect({ width: 300, height: 100 }, { width: 0, height: 0 })
    ).deep.equals({
      x: 0,
      y: 0,
      w: 300,
      h: 100
    })
  })

  it('draws the background at its cover rect, the title on one line and the message on three, in Dark text', async () => {
    const getSize = Object.getOwnPropertyDescriptor(Image, 'getSize')!
    Object.defineProperty(Image, 'getSize', {
      configurable: true,
      value: (_uri: string, success: (w: number, h: number) => void) => {
        success(1920, 224)
      }
    })
    try {
      await mount(<SponsoredScheduleRow {...ROW} />)
      const row = document.querySelector<HTMLElement>(
        '[data-testid="sponsored-schedule-row"]'
      )!
      // jsdom lays nothing out: report a 360 × 112 row.
      await act(async () => {
        const layout = { x: 0, y: 0, width: 360, height: 112 }
        const handler = (
          row as HTMLElement & {
            __reactLayoutHandler?: (event: unknown) => void
          }
        ).__reactLayoutHandler
        handler?.({ nativeEvent: { layout } })
      })
      await settle(0)
      const background = document.querySelector<HTMLElement>(
        '[data-testid="sponsored-row-background"]'
      )!
      expect(background, 'the background').not.equals(null)
      expect(background.style.left).equals('-600px')
      expect(background.style.top).equals('0px')
      expect(background.style.width).equals('960px')
      expect(row.textContent).includes('Bayside Bakery')
      expect(row.textContent).includes('Sponsored')
      const title = [...row.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
        node => node.textContent === 'Bayside Bakery'
      )!
      const message = [
        ...row.querySelectorAll<HTMLElement>('[dir="auto"]')
      ].find(node => node.textContent === ROW.message)!
      expect(getComputedStyle(title).whiteSpace).equals('nowrap')
      expect(message.style.getPropertyValue('-webkit-line-clamp')).equals('3')
      expect(getComputedStyle(title).color).equals('rgb(28, 28, 30)')
      expect(TEXT_COLORS.dark.color).equals('#1C1C1E')
    } finally {
      Object.defineProperty(Image, 'getSize', getSize)
    }
  })

  it('writes White text with a dark shadow, and stands in for an empty title and message', async () => {
    await mount(
      <SponsoredScheduleRow
        {...ROW}
        title=""
        message=""
        textColor="white"
        logoUrl=""
        backgroundUrl=""
      />
    )
    const row = document.querySelector<HTMLElement>(
      '[data-testid="sponsored-schedule-row"]'
    )!
    expect(row.textContent).includes('Sponsor title')
    expect(row.textContent).includes('Sponsor message')
    const title = [...row.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
      node => node.textContent === 'Sponsor title'
    )!
    expect(getComputedStyle(title).color).equals('rgb(255, 255, 255)')
    expect(document.querySelector('[data-testid="sponsored-row-logo"]')).equals(
      null
    )
    expect(
      document.querySelector('[data-testid="sponsored-row-background"]')
    ).equals(null)
  })

  it('opens the website when pressed, in a new tab on the web', async () => {
    const opened: unknown[][] = []
    const realOpen = Object.getOwnPropertyDescriptor(window, 'open')
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        opened.push(args)
        return null
      }
    })
    try {
      await mount(<SponsoredScheduleRow {...ROW} />)
      await act(async () => {
        document
          .querySelector<HTMLElement>('[data-testid="sponsored-schedule-row"]')!
          .click()
      })
      expect(opened).deep.equals([
        ['https://example.test/bread', '_blank', 'noopener']
      ])
    } finally {
      if (realOpen == null) Reflect.deleteProperty(window, 'open')
      else Object.defineProperty(window, 'open', realOpen)
    }
  })

  it('opens the website in the phone’s browser on iOS and Android, and nothing but https', async () => {
    const opened: string[] = []
    const tabs: string[] = []
    for (const os of ['ios', 'android']) {
      openSponsorUrl(ROW.url, {
        os,
        open: url => tabs.push(url),
        openURL: async url => {
          opened.push(url)
        }
      })
    }
    openSponsorUrl('http://example.test/bread', {
      os: 'ios',
      openURL: async url => {
        opened.push(url)
      }
    })
    openSponsorUrl('javascript:alert(1)', {
      os: 'web',
      open: url => tabs.push(url)
    })
    expect(opened).deep.equals([ROW.url, ROW.url])
    expect(tabs).deep.equals([])
    // A browser the phone could not open is let go quietly.
    openSponsorUrl(ROW.url, {
      os: 'ios',
      openURL: async () => {
        throw new Error('no browser')
      }
    })
  })
})
