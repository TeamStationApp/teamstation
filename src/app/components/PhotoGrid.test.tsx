import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AvailablePicture } from '../../common/pictureCatalog'
import { ThemeProvider } from '../theme/ThemeContext'
import { CreationCard } from './CreationCard'
import { PhotoGrid } from './PhotoGrid'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
describe('shared picture grid and creation cards', () => {
  it('puts outlined upload first, exposes three columns, and preserves selected state', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    let selected = ''
    let uploads = 0
    const entries = [
      {
        id: 'baseball',
        label: 'Baseball',
        kind: 'photo',
        url: 'data:image/png;base64,AAAA'
      },
      { id: 'flag', label: 'Flag', kind: 'creation', url: '' }
    ] as AvailablePicture[]
    const render = async (selectedId?: string): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <PhotoGrid
              entries={entries}
              selectedId={selectedId}
              onSelect={id => {
                selected = id
              }}
              onUpload={() => {
                uploads++
              }}
            />
          </ThemeProvider>
        )
      })
    }
    await render()
    const buttons = host.querySelectorAll<HTMLElement>('[role="button"]')
    expect(buttons).length(2)
    expect(buttons[0].getAttribute('aria-label')).equals('Add Photo')
    expect(parseFloat(getComputedStyle(buttons[0]).width)).closeTo(
      100 / 3,
      0.001
    )
    await act(async () => {
      buttons[0].click()
      buttons[1].click()
    })
    expect(uploads).equals(1)
    expect(selected).equals('baseball')
    await render(selected)
    expect(host.textContent).includes('✓')
  })
  it('renders centered heading and left-aligned description with one creation action', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    let clicked = false
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <CreationCard
            title="Create League"
            description="A recurring organization"
            icon={{ uri: 'data:image/png;base64,AAAA' }}
            onPress={() => {
              clicked = true
            }}
          />
        </ThemeProvider>
      )
    })
    expect(host.textContent)
      .includes('Create League')
      .and.includes('A recurring organization')
    await act(async () => {
      host.querySelector<HTMLElement>('[role="button"]')!.click()
    })
    expect(clicked).equals(true)
  })
})
