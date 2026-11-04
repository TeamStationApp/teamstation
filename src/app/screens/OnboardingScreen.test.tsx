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
  done: () => Promise<void> = async () => {},
  allowCatalog?: boolean
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
          allowCatalog={allowCatalog}
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
    await render(client, 'photo', undefined, true)
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
  it('offers only a photo or initials, without loading sports pictures', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let catalogRequests = 0
    client.pictures = async () => {
      catalogRequests++
      return []
    }
    const finished: unknown[] = []
    client.finishOnboarding = async choice => {
      finished.push(choice)
    }
    await render(client, 'photo')
    expect(catalogRequests).equals(0)
    expect(
      document.querySelector('[data-testid="sports-picture-grid"]')
    ).equals(null)
    expect(document.body.textContent).includes(
      'Add a photo from your photo album or use your initials.'
    )
    expect(document.body.textContent).not.includes('sports picture')
    const continueButton = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Continue')!
    expect(continueButton.getAttribute('aria-disabled')).equals('true')
    await press('Add Photo')
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [{ type: 'image/png', size: 3 }]
    })
    const original = globalThis.FileReader
    class Reader {
      result = 'data:image/png;base64,AAAA'
      onload?: () => void
      readAsDataURL(): void {
        this.onload?.()
      }
    }
    globalThis.FileReader = Reader as unknown as typeof FileReader
    try {
      await act(async () => {
        input.dispatchEvent(new window.Event('change'))
        await Promise.resolve()
      })
    } finally {
      globalThis.FileReader = original
    }
    expect(
      document.querySelector('[aria-label="Selected profile photo"]')
    ).not.equals(null)
    await press('Continue')
    expect(finished).length(1)
    expect(finished[0]).deep.equals({
      image: { contentType: 'image/png', base64: 'AAAA' }
    })
    await press('Use my initials')
    expect(finished[1]).deep.equals({ initials: true })
    expect(catalogRequests).equals(0)
  })
})
