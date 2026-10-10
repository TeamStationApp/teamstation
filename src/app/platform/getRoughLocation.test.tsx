import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { getRoughLocation } from './getRoughLocation'

const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
afterEach(() => {
  if (original != null)
    Object.defineProperty(navigator, 'geolocation', original)
  else Reflect.deleteProperty(navigator, 'geolocation')
})
describe('browser rough-location boundary', () => {
  it('handles absent browser location and one-shot granted/denied estimates', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: undefined
    })
    expect(await getRoughLocation()).deep.equals({ status: 'unavailable' })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { latitude: number; longitude: number }
          }) => void
        ) => {
          success({ coords: { latitude: 1, longitude: 2 } })
        }
      }
    })
    expect(await getRoughLocation()).property('status', 'success')
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: unknown,
          failure: (error: { code: number }) => void
        ) => {
          failure({ code: 1 })
        }
      }
    })
    expect(await getRoughLocation()).deep.equals({ status: 'denied' })
  })
})
