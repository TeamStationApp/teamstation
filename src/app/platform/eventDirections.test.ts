import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  googleDirectionsUrl,
  openNativeDirections,
  openNativePointDirections,
  pointDirectionsUrls
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

describe('directions to a field’s point', () => {
  const point = {
    latitude: 40.0212,
    longitude: -75.2191,
    label: 'Example Park · Field 1'
  }
  const label = encodeURIComponent('Example Park · Field 1')
  it('routes to the coordinates on every platform, labelled where a maps app shows it', () => {
    expect(pointDirectionsUrls(point)).deep.equals({
      web: 'https://www.google.com/maps/dir/?api=1&destination=40.0212,-75.2191',
      apple: `https://maps.apple.com/?daddr=40.0212,-75.2191&q=${label}`,
      google: 'comgooglemaps://?daddr=40.0212,-75.2191',
      android: `geo:40.0212,-75.2191?q=40.0212,-75.2191(${label})`
    })
  })
  for (const installed of [true, false])
    it(`offers Apple Maps on iOS, and Google Maps only when installed (${installed})`, async () => {
      for (const choice of installed ? [0, 1] : [0]) {
        const opened: string[] = []
        let options: string[] = []
        await openNativePointDirections(
          point,
          'ios',
          {
            canOpenURL: async url => {
              expect(url).equals('comgooglemaps://')
              return installed
            },
            openURL: async url => {
              opened.push(url)
            }
          },
          {
            showActionSheetWithOptions: (config, chosen) => {
              options = config.options
              expect(config.cancelButtonIndex).equals(options.length - 1)
              chosen(choice)
            }
          }
        )
        expect(options).deep.equals(
          installed
            ? ['Apple Maps', 'Google Maps', 'Cancel']
            : ['Apple Maps', 'Cancel']
        )
        expect(opened).deep.equals([
          choice === 0
            ? pointDirectionsUrls(point).apple
            : pointDirectionsUrls(point).google
        ])
      }
    })
  it('cancels without opening, and keeps Apple Maps when detection fails', async () => {
    let calls = 0
    await openNativePointDirections(
      point,
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
        showActionSheetWithOptions: (config, chosen) => {
          expect(config.options).deep.equals(['Apple Maps', 'Cancel'])
          chosen(config.cancelButtonIndex)
        }
      }
    )
    expect(calls).equals(0)
  })
  it('propagates a failure to open the chosen app', async () => {
    try {
      await openNativePointDirections(
        point,
        'ios',
        {
          canOpenURL: async () => false,
          openURL: async () => {
            throw new Error('Could not open maps')
          }
        },
        {
          showActionSheetWithOptions: (_config, chosen) => {
            chosen(0)
          }
        }
      )
      expect.fail('must reject')
    } catch (error) {
      expect(String(error)).includes('Could not open maps')
    }
  })
  it('uses Android’s geo handler at the point, falling back to Google’s web directions', async () => {
    const opened: string[] = []
    const sheet = {
      showActionSheetWithOptions: () => {
        throw new Error('must not use the iOS sheet')
      }
    }
    await openNativePointDirections(
      point,
      'android',
      {
        canOpenURL: async () => false,
        openURL: async url => {
          opened.push(url)
          if (url.startsWith('geo:')) throw new Error('no installed handler')
        }
      },
      sheet
    )
    expect(opened).deep.equals([
      pointDirectionsUrls(point).android,
      pointDirectionsUrls(point).web
    ])
    opened.length = 0
    await openNativePointDirections(
      point,
      'android',
      {
        canOpenURL: async () => false,
        openURL: async url => {
          opened.push(url)
        }
      },
      sheet
    )
    expect(opened).deep.equals([pointDirectionsUrls(point).android])
  })
  it('leaves the address directions as they were', () => {
    expect(googleDirectionsUrl('1 Example Way')).equals(
      'https://www.google.com/maps/dir/?api=1&destination=1%20Example%20Way'
    )
  })
})
