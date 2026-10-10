import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { AppleMusicSetup, openMusicSettings } from './AppleMusicSetup'

/**
 * The Apple Music settings walkthrough: three pages, dark on the light app,
 * with Go to Settings, Back, Done and a close on every page.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Seen {
  closed: number
  settings: number
}

async function render(): Promise<Seen> {
  const seen: Seen = { closed: 0, settings: 0 }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <AppleMusicSetup
          visible
          onClose={() => {
            seen.closed++
          }}
          openSettings={(...args: unknown[]) => {
            // Called bare, never with the press event.
            expect(args).deep.equals([])
            seen.settings++
          }}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
  return seen
}

const text = (): string => document.body.textContent ?? ''
function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.getAttribute('aria-label') === label
  )
}
async function press(label: string): Promise<void> {
  const found = button(label)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(20)
  })
}
/** jsdom reports colours as `rgb(…)`; the themes write hex. */
function rgb(hex: string): string {
  const probe = document.createElement('div')
  probe.style.color = hex
  return probe.style.color
}

describe('AppleMusicSetup', function () {
  // Inside the suite, so the modal's portal is unmounted before any
  // root-level hook clears the document.
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('opens on what to turn on: the intro and the four settings', async function () {
    await render()
    expect(text()).includes(
      'For the best and most reliable experience with TeamStation DJ, enable the following settings in your Apple Music app.'
    )
    for (const name of [
      'Add Playlist Songs',
      'Sync Library',
      'Download over Cellular',
      'Automatic Downloads'
    ]) {
      expect(text()).includes(name)
    }
    expect(button('Go to Settings')).equals(undefined)
    expect(button('Back')).equals(undefined)
  })

  it('pages through the settings, with Go to Settings, Back and Done', async function () {
    const seen = await render()
    await press('Next')
    expect(text()).includes('Settings › Apps › Music')
    expect(text()).not.includes('don’t download by themselves')
    expect(button('Back')).equals(undefined)
    await press('Go to Settings')
    expect(seen.settings).equals(1)
    await press('Next')
    expect(text()).includes('Open the TeamStation walkup songs playlist')
    await press('Back')
    expect(text()).not.includes('don’t download by themselves')
    await press('Next')
    await press('Go to Settings')
    expect(seen.settings).equals(2)
    expect(seen.closed).equals(0)
    await press('Done')
    expect(seen.closed).equals(1)
  })

  it('opens again on its first page, wherever it was closed', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const show = async (visible: boolean): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <AppleMusicSetup visible={visible} onClose={() => undefined} />
          </ThemeProvider>
        )
        await delay(20)
      })
    }
    await show(true)
    await press('Next')
    await press('Next')
    expect(text()).includes('don’t download by themselves')
    await show(false)
    await show(true)
    expect(text()).includes('TeamStation DJ, enable the following')
  })

  it('closes from every page', async function () {
    const seen = await render()
    await press('Close')
    await press('Next')
    await press('Close')
    await press('Next')
    await press('Close')
    expect(seen.closed).equals(3)
  })

  it('is dark on the light app theme', async function () {
    expect(tsBallpark.isDark).equals(false)
    await render()
    const screen = document.querySelector<HTMLElement>(
      '[data-testid="apple-music-setup"]'
    )!
    expect(getComputedStyle(screen).backgroundColor).equals(
      rgb(tsDark.backgroundColor)
    )
    const next = button('Next')!
    expect(getComputedStyle(next).backgroundColor).equals(
      rgb(tsDark.primaryButtonColor)
    )
    const label = [...next.querySelectorAll<HTMLElement>('div')].find(
      node => node.textContent === 'Next'
    )!
    expect(getComputedStyle(label).color).equals(rgb(tsDark.buttonTextColor))
  })

  it('writes every page’s words in a colour that shows on the page', async function () {
    await render()
    await press('Next')
    await press('Next')
    const note = [...document.querySelectorAll<HTMLElement>('div')].find(
      node =>
        node.childElementCount === 0 &&
        (node.textContent ?? '').includes('don’t download by themselves')
    )!
    expect(note).not.equals(undefined)
    expect(getComputedStyle(note).color).not.equals(rgb(tsDark.backgroundColor))
  })

  it('opens Music’s page in Settings, and TeamStation’s when iOS refuses it', async function () {
    const opened: string[] = []
    const linking = (
      refuse: boolean
    ): Parameters<typeof openMusicSettings>[0] => ({
      openURL: async (url: string) => {
        opened.push(url)
        if (refuse) throw new Error('Unable to open URL')
      },
      openSettings: async () => {
        opened.push('app settings')
      }
    })
    openMusicSettings(linking(false))
    await delay(10)
    expect(opened).deep.equals(['App-prefs:com.apple.Music'])
    opened.length = 0
    openMusicSettings(linking(true))
    await delay(10)
    expect(opened).deep.equals(['App-prefs:com.apple.Music', 'app settings'])
  })
})
