import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { OnboardingScreen } from './OnboardingScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
}
async function render(
  client: TeamStationClient,
  step: 'name' | 'photo',
  done: () => Promise<void> = async () => {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <OnboardingScreen
          client={client}
          initialName="Mike Trout"
          initialState={{ step, completedAt: null }}
          onComplete={done}
        />
      </ThemeProvider>
    )
  })
}
describe('resumable onboarding screen', () => {
  it('keeps a failed name/photo save retryable and completes with initials', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.pictures = async () => []
    client.saveOnboardingName = async () => {
      throw new Error('Name save unavailable')
    }
    await render(client, 'name')
    await press('Continue')
    expect(document.body.textContent).includes('Name save unavailable')
    client.saveOnboardingName = async name => ({
      displayName: name,
      onboarding: { step: 'photo', completedAt: null }
    })
    await press('Continue')
    expect(document.body.textContent).includes('Choose your photo')
    client.finishOnboarding = async () => {
      throw new Error('Photo save unavailable')
    }
    await press('Use my initials')
    expect(document.body.textContent).includes('Photo save unavailable')
    client.finishOnboarding = async () => {}
    await press('Use my initials')
  })
  it('allows catalog retry, preserves a selected picture on failure and handles album cancellation', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.pictures = async () => {
      throw new Error('Unavailable')
    }
    await render(client, 'photo')
    expect(document.body.textContent).includes('could not load')
    client.pictures = async () => [
      {
        id: 'baseball',
        label: 'Baseball',
        kind: 'photo',
        prefix: 'images/catalog/baseball',
        sha256: '',
        width: 192,
        height: 192,
        url: 'data:image/png;base64,AAAA'
      }
    ]
    await press('Retry pictures')
    await press('Baseball')
    client.finishOnboarding = async () => {
      throw new Error('Retry picture save')
    }
    await press('Continue')
    expect(document.body.textContent).includes('Retry picture save')
    expect(document.body.textContent).includes('✓')
    await press('Add Photo')
    document
      .querySelector('input[type="file"]')!
      .dispatchEvent(new window.Event('cancel'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).includes('✓')
    client.finishOnboarding = async () => {}
    await press('Continue')
  })
})
