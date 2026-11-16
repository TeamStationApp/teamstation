import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { storedPictures } from '../../test/storedPictures'
import { ThemeProvider } from '../theme/ThemeContext'
import { PictureDirectoriesContext } from './CachedPicture'
import { PlacePhoto } from './PlacePhoto'

let root: Root | undefined
let host: HTMLElement | undefined
/** Every picture react-native-web asked the browser for. */
let requested: string[] = []
const originalImage = window.Image

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

const VENUE = 'https://cdn.example.test/images/venue/cc-640.png'
const FIELD = 'https://cdn.example.test/images/field/dd-640.png'

describe('PlacePhoto', function () {
  before(function () {
    window.Image = class {
      onerror: unknown
      onload: unknown
      private source = ''
      get src(): string {
        return this.source
      }

      set src(value: string) {
        this.source = value
        requested.push(value)
      }
    } as unknown as typeof Image
  })
  after(function () {
    window.Image = originalImage
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    host = undefined
    requested = []
  })

  it('draws a stored venue or field photo offline', async function () {
    const { directories, fileOf } = await storedPictures([VENUE, FIELD])
    const container = await render(
      <PictureDirectoriesContext.Provider value={directories}>
        <PlacePhoto uri={VENUE} label="Example Park" />
        <PlacePhoto uri={FIELD} label="Field 1" />
      </PictureDirectoriesContext.Provider>
    )
    expect(requested).deep.equals([fileOf(VENUE), fileOf(FIELD)])
    expect(container.querySelectorAll('[data-testid="place-photo"]')).length(2)
    expect(container.querySelector('[data-testid="place-photo-empty"]')).equals(
      null
    )
  })

  it('draws the empty frame offline with none stored, and with no photo', async function () {
    const { directories } = await storedPictures([])
    const container = await render(
      <PictureDirectoriesContext.Provider value={directories}>
        <PlacePhoto uri={VENUE} label="Example Park" />
        <PlacePhoto uri={null} label="Field 1" />
      </PictureDirectoriesContext.Provider>
    )
    expect(requested).deep.equals([])
    expect(
      container.querySelectorAll('[data-testid="place-photo-empty"]')
    ).length(2)
    expect(
      container
        .querySelector('[data-testid="place-photo-empty"]')
        ?.getAttribute('aria-label')
    ).equals('Example Park: no photo yet')
  })

  it('draws the photo from its URL where no directory is open', async function () {
    await render(<PlacePhoto uri={VENUE} label="Example Park" />)
    expect(requested).deep.equals([VENUE])
  })
})
