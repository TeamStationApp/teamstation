import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { copyEventAddress, openEventDirections } from './eventDirections'

const originalOpen = window.open.bind(window)
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalCopy = document.execCommand?.bind(document)
afterEach(() => {
  window.open = originalOpen
  if (clipboard == null) delete (navigator as { clipboard?: unknown }).clipboard
  else Object.defineProperty(navigator, 'clipboard', clipboard)
  document.execCommand = originalCopy
})
describe('browser address actions', () => {
  it('encodes directions and removes the new window’s opener', async () => {
    const destination = { opener: window } as unknown as Window
    let url = ''
    window.open = input => {
      url = String(input)
      return destination
    }
    await openEventDirections('1 Demo Way & Park')
    expect(url).includes('1%20Demo%20Way%20%26%20Park')
    expect(destination.opener).equals(null)
    window.open = () => null
    await openEventDirections('1 Demo Way')
  })
  it('copies through clipboard, falls back to selected text and cleans up on failure', async () => {
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied = value
        }
      }
    })
    await copyEventAddress('1 Demo Way')
    expect(copied).equals('1 Demo Way')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined
    })
    document.execCommand = () => true
    await copyEventAddress('2 Demo Way')
    expect(document.querySelector('textarea')).equals(null)
    document.execCommand = () => false
    try {
      await copyEventAddress('3 Demo Way')
      expect.fail('must reject')
    } catch (error) {
      expect(String(error)).includes('could not be copied')
    }
    expect(document.querySelector('textarea')).equals(null)
  })
})
