import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  googleDirectionsUrl,
  openNativeDirections
} from './eventDirectionsNative'

describe('event mapping app choices', () => {
  const address = '1 Demo Way & Park #2'
  it('encodes the address as a route destination', () => {
    expect(googleDirectionsUrl(address)).equals(
      'https://www.google.com/maps/dir/?api=1&destination=' +
        encodeURIComponent(address)
    )
  })
  for (const installed of [true, false])
    it(`offers Apple first and Google only when installed (${installed})`, async () => {
      const opened: string[] = []
      let options: string[] = []
      await openNativeDirections(
        address,
        'ios',
        {
          canOpenURL: async () => installed,
          openURL: async url => {
            opened.push(url)
          }
        },
        {
          showActionSheetWithOptions: (config, chosen) => {
            options = config.options
            chosen(installed ? 1 : 0)
          }
        }
      )
      expect(options).deep.equals(
        installed
          ? ['Apple Maps', 'Google Maps', 'Cancel']
          : ['Apple Maps', 'Cancel']
      )
      expect(opened[0]).equals(
        (installed ? 'comgooglemaps://' : 'https://maps.apple.com/') +
          '?q=' +
          encodeURIComponent(address)
      )
    })
  it('allows cancel and recovers failed app detection without hiding Apple', async () => {
    let calls = 0
    await openNativeDirections(
      address,
      'ios',
      {
        canOpenURL: async () => {
          throw new Error('lookup unavailable')
        },
        openURL: async () => {
          calls++
        }
      },
      {
        showActionSheetWithOptions: (options, chosen) => {
          expect(options.options).deep.equals(['Apple Maps', 'Cancel'])
          chosen(options.cancelButtonIndex)
        }
      }
    )
    expect(calls).equals(0)
  })
  it('uses Android’s default geo handler with an encoded Google browser fallback', async () => {
    const opened: string[] = []
    const links = {
      canOpenURL: async () => false,
      openURL: async (url: string) => {
        opened.push(url)
        if (url.startsWith('geo:')) throw new Error('no installed handler')
      }
    }
    await openNativeDirections(address, 'android', links, {
      showActionSheetWithOptions: () => {
        throw new Error('must not use iOS sheet')
      }
    })
    expect(opened).deep.equals([
      'geo:0,0?q=' + encodeURIComponent(address),
      googleDirectionsUrl(address)
    ])
    opened.length = 0
    await openNativeDirections(
      address,
      'android',
      {
        ...links,
        openURL: async url => {
          opened.push(url)
        }
      },
      { showActionSheetWithOptions: () => undefined }
    )
    expect(opened).deep.equals(['geo:0,0?q=' + encodeURIComponent(address)])
  })
  it('propagates a directions failure so the screen can show it', async () => {
    try {
      await openNativeDirections(
        address,
        'ios',
        {
          canOpenURL: async () => false,
          openURL: async () => {
            throw new Error('Could not open maps')
          }
        },
        {
          showActionSheetWithOptions: (_options, chosen) => {
            chosen(0)
          }
        }
      )
      expect.fail('must reject')
    } catch (error) {
      expect(String(error)).includes('Could not open maps')
    }
  })
})
