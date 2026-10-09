import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { copyChatText } from './chatClipboard'

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard'
)
const originalCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

afterEach(function () {
  if (originalClipboard != null)
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (originalCommand != null)
    Object.defineProperty(document, 'execCommand', originalCommand)
  else Reflect.deleteProperty(document, 'execCommand')
})

describe('chat decrypted text clipboard', function () {
  it('copies exact Unicode body or caption through the browser clipboard', async function () {
    const copies: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copies.push(text)
        }
      }
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('Fallback should not run')
      }
    })
    await copyChatText('  Bring water\nCaption ❤️  ')
    expect(copies).deep.equals(['  Bring water\nCaption ❤️  '])
    expect(document.querySelector('textarea')).equals(null)
  })

  it('falls back after browser permission denial, removes its temporary field and restores focus', async function () {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const copies: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Denied')
        }
      }
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string) => {
        expect(command).equals('copy')
        copies.push(document.querySelector('textarea')!.value)
        return true
      }
    })
    await copyChatText('Caption from opened content')
    expect(copies).deep.equals(['Caption from opened content'])
    expect(document.querySelector('textarea')).equals(null)
    expect(document.activeElement).equals(trigger)
  })

  it('reports unavailable copying and cleans up after false success or an exception', async function () {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined
    })
    for (const command of [
      undefined,
      () => false,
      () => {
        throw new Error('Denied')
      }
    ]) {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: command
      })
      let failed: unknown
      await copyChatText('Opened body').catch((error: unknown) => {
        failed = error
      })
      expect(failed).instanceOf(Error)
      expect(document.querySelector('textarea')).equals(null)
    }
  })

  it('does not restore a trigger that disappeared while copying', async function () {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        trigger.remove()
        return true
      }
    })
    await copyChatText('Opened body')
    expect(document.querySelector('textarea')).equals(null)
    expect(document.activeElement).not.equals(trigger)
  })
})
