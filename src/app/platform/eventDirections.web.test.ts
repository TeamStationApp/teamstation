import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  copyEventAddress,
  openEventDirections,
  openPointDirections
} from './eventDirections'

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
  it('opens the encoded destination directly with no opener or intermediate blank page', async () => {
    let url = ''
    let features = ''
    let target = ''
    window.open = (input, nextTarget, nextFeatures) => {
      url = String(input)
      target = nextTarget ?? ''
      features = nextFeatures ?? ''
      return null
    }
    await openEventDirections('1 Demo Way & Park')
    expect(url).not.equals('about:blank')
    expect(url).includes(
      '/maps/dir/?api=1&destination=1%20Demo%20Way%20%26%20Park'
    )
    expect(target).equals('_blank')
    expect(features).equals('noopener,noreferrer')
  })
  it('opens a point’s Google directions by its coordinates, and logs the URL in development', async () => {
    const opened: Array<[string, string, string]> = []
    window.open = (input, target, features) => {
      opened.push([String(input), target ?? '', features ?? ''])
      return null
    }
    const info = console.info
    const logged: unknown[] = []
    console.info = (...args: unknown[]) => {
      logged.push(...args)
    }
    const global = globalThis as { __DEV__?: boolean }
    const before = global.__DEV__
    global.__DEV__ = true
    try {
      await openPointDirections({
        latitude: 40.0212,
        longitude: -75.2191,
        label: 'Example Park · Field 1'
      })
    } finally {
      console.info = info
      if (before === undefined) delete global.__DEV__
      else global.__DEV__ = before
    }
    const url =
      'https://www.google.com/maps/dir/?api=1&destination=40.0212,-75.2191'
    expect(opened).deep.equals([[url, '_blank', 'noopener,noreferrer']])
    expect(logged).deep.equals(['[directions] ' + url])
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
