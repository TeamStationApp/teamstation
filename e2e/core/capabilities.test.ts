import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  browserNeedProblems,
  capabilityProblems,
  deviceNeedProblems,
  gpuProblems,
  isCapability,
  placement,
  simulatorFor
} from './capabilities'

describe('capabilities', function () {
  it('names an unknown capability on a role in the new vocabulary', function () {
    expect(
      deviceNeedProblems({
        role: 'coach',
        needs: ['ios-phone', 'jetpack'],
        hardware: 'none',
        simulator: 'never'
      })
    ).deep.equals(['role "coach": unknown capability "jetpack"'])
    expect(isCapability('keyboard-hardware')).equals(true)
    expect(isCapability('ios')).equals(false)
  })

  it("makes simulator: 'allowed' with camera a spec problem", function () {
    expect(
      deviceNeedProblems({
        role: 'cam',
        needs: ['ios-phone', 'camera'],
        hardware: 'none',
        simulator: 'allowed'
      })
    ).deep.equals([
      'role "cam": simulator: \'allowed\' with camera, which only a real device has'
    ])
  })

  it('names a role with no class or a bad simulator, and leaves an unconverted role alone', function () {
    expect(
      deviceNeedProblems({
        role: 'r',
        needs: ['gpu'],
        hardware: 'none',
        simulator: 'sometimes' as never
      })
    ).deep.equals([
      'role "r": simulator is allowed or never, not "sometimes"',
      'role "r": names no device class'
    ])
    expect(
      deviceNeedProblems({ role: 'r', needs: ['ios'], hardware: 'required' })
    ).deep.equals([])
  })

  it("treats a role without simulator as 'never', and camera, push or gpu as 'never' always", function () {
    expect(
      simulatorFor({ role: 'r', needs: ['ipad'], hardware: 'none' })
    ).equals('never')
    expect(
      simulatorFor({
        role: 'r',
        needs: ['ipad'],
        hardware: 'none',
        simulator: 'allowed'
      })
    ).equals('allowed')
    expect(
      simulatorFor({
        role: 'r',
        needs: ['ipad', 'push'],
        hardware: 'none',
        simulator: 'allowed'
      })
    ).equals('never')
  })

  it('places a browser with video or gpu on the Mac, and one with neither on a droplet', function () {
    expect(placement({ role: 'b', needs: ['video'], codecs: ['hevc'] })).equals(
      'mac'
    )
    expect(placement({ role: 'b', needs: ['gpu'] })).equals('mac')
    expect(placement({ role: 'b', needs: [] })).equals('droplet')
    expect(placement(undefined)).equals('droplet')
  })

  it('names an unknown browser feature, codecs without video, and a browser on a phone surface', function () {
    expect(
      browserNeedProblems({ role: 'b', needs: ['webgl'], codecs: ['hevc'] })
    ).deep.equals([
      'browser "b": unknown browser feature "webgl"',
      'browser "b": codecs without video'
    ])
    expect(
      capabilityProblems({
        surfaces: {
          'ios-app': {
            devices: [
              {
                role: 'r',
                needs: ['ios-phone', 'laser'],
                hardware: 'none',
                simulator: 'never'
              }
            ],
            browser: { role: 'b', needs: ['video'] }
          }
        }
      })
    ).deep.equals([
      'ios-app: role "r": unknown capability "laser"',
      'ios-app: a browser need is for a web surface'
    ])
  })

  it('reports a spec covering the scoring, replay or field screens without gpu', function () {
    const surfaces = {
      'ios-app': {
        devices: [
          { role: 'scorer', needs: ['ipad'], hardware: 'required' as const }
        ]
      },
      'web-chromium': { devices: [], browser: { role: 'b', needs: [] } }
    }
    for (const covers of [
      ['src/app/scoring/**'],
      ['src/app/replay/ReplayScreen.tsx'],
      ['src/app/field/**'],
      ['src/app/**']
    ]) {
      expect(gpuProblems({ covers, surfaces })).deep.equals([
        'ios-app: role "scorer" covers a 3D screen without gpu',
        'web-chromium: the browser covers a 3D screen without gpu'
      ])
    }
    expect(
      gpuProblems({
        covers: ['src/app/scoring/**'],
        surfaces: {
          'ios-app': {
            devices: [
              { role: 'scorer', needs: ['ipad', 'gpu'], hardware: 'required' }
            ]
          },
          'web-chromium': {
            devices: [],
            browser: { role: 'b', needs: ['gpu'] }
          }
        }
      })
    ).deep.equals([])
    expect(gpuProblems({ covers: ['src/app/chat/**'], surfaces })).deep.equals(
      []
    )
  })
})
