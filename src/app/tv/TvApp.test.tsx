/* eslint-disable @typescript-eslint/unbound-method -- Save and restore prototype methods without invoking them. */
// The bundler loads the separate TV entry without extending the app tsconfig root.
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppRegistry, NativeModules } from 'react-native'

import { asSession, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { TvApp } from './TvApp'

require('../../../appletv/index.js')

const session = asSession({
  token: 'fixture-session',
  expiresAt: '2030-01-01',
  user: { id: userIdOfGumbo(101), displayName: 'Babe Ruth', isAdmin: false }
})
let root: Root | undefined
const original = {
  start: TeamStationClient.prototype.startTvLogin,
  claim: TeamStationClient.prototype.claimTvLogin,
  me: TeamStationClient.prototype.whoAmI,
  out: TeamStationClient.prototype.signOut,
  store: NativeModules.TVSession
}
const pause = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function render(probeUrls?: string): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <TvApp apiBaseUrl="https://example.test/api/v1" probeUrls={probeUrls} />
    )
    await pause()
  })
}
async function press(label: string): Promise<void> {
  const button = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
  expect(button).not.equals(null)
  await act(async () => {
    button.focus()
    button.click()
    button.blur()
    await pause()
  })
}
function setup(saved: string | null = null): void {
  NativeModules.TVSession = {
    load: async () => saved,
    save: async (value: string) => {
      saved = value
    },
    clear: async () => {
      saved = null
    }
  }
  TeamStationClient.prototype.startTvLogin = async () => ({
    requestId: 'fixture',
    clientSecret: 'secret',
    displayCode: 'ABCD–EFGH',
    qrUrl: 'https://app.teamstation.app/tv-login?token=fixture',
    expiresAt: Date.now() + 120000
  })
  TeamStationClient.prototype.claimTvLogin = async () => ({ ready: false })
  TeamStationClient.prototype.whoAmI = async () => session.user
  TeamStationClient.prototype.signOut = async () => undefined
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  Object.assign(TeamStationClient.prototype, {
    startTvLogin: original.start,
    claimTvLogin: original.claim,
    whoAmI: original.me,
    signOut: original.out
  })
  NativeModules.TVSession = original.store
})
describe('TV app presentation', () => {
  it('registers the native entry point', () => {
    expect(AppRegistry.getAppKeys()).contains('TeamStationTV')
  })
  it('renders QR and letters, counts down and switches to an approved session', async () => {
    setup()
    await render()
    expect(document.body.textContent).contains('ABCD–EFGH')
    expect(document.querySelector('svg path')).not.equals(null)
    TeamStationClient.prototype.claimTvLogin = async () => session
    await act(async () => {
      await pause(3200)
    })
    expect(document.body.textContent).contains('Welcome, Babe Ruth')
    await press('Sign out')
    expect(document.body.textContent).contains('ABCD–EFGH')
  })
  it('restores a saved session and retries recoverable failures', async () => {
    setup(JSON.stringify({ origin: 'https://example.test/api/v1', session }))
    await render()
    expect(document.body.textContent).contains('Welcome, Babe Ruth')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    setup()
    NativeModules.TVSession.load = async () => {
      throw new Error('Storage unavailable')
    }
    await render()
    expect(document.body.textContent).contains('Storage unavailable')
    NativeModules.TVSession.load = async () => null
    await press('Retry')
    expect(document.body.textContent).contains('ABCD–EFGH')
  })
  it('keeps all player elements mounted through probe visibility and sizing changes', async () => {
    setup()
    await render(
      'https://example.test/a.mp4|https://example.test/b.mp4|https://example.test/c.mp4|https://example.test/d.mp4'
    )
    const videos = [...document.querySelectorAll('video')]
    expect(videos).length(4)
    await act(async () => {
      videos.forEach((video, index) => {
        Object.defineProperty(video, 'currentTime', {
          configurable: true,
          value: index + 2
        })
        video.dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      })
      await pause()
    })
    await press('Hide angle 2')
    await press('Enlarge angle 1')
    await press('Restore angle 2')
    await press('Collapse angle 1')
    expect([...document.querySelectorAll('video')]).deep.equals(videos)
    await act(async () => {
      Object.defineProperty(videos[0], 'error', {
        configurable: true,
        value: { code: 3, message: 'fixture decode error' }
      })
      videos[0].dispatchEvent(new window.Event('error', { bubbles: true }))
      await pause()
    })
    expect(document.body.textContent).contains('Angle 1 failed')
  })
})
