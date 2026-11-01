import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  configurationOfInit,
  hevcHeaderOf,
  publishDiffers,
  silenceFor,
  soundHeaderOf
} from './decoderConfig'
import {
  configuredInit,
  hevcHeaderBody,
  hevcInit,
  parameterSetNals,
  soundHeaderBody
} from './frameWallFixture'

const SOUND = Buffer.from([0x11, 0x90])
const OTHER_SOUND = Buffer.from([0x12, 0x10])

describe("whether a publish can share a recording's init segment", function () {
  const held = configurationOfInit(configuredInit(parameterSetNals(1), SOUND))!

  it("reads an init segment's parameter sets and sound", function () {
    expect(held.parameterSets).length(3)
    expect(held.sound?.equals(SOUND)).equals(true)
  })

  it('reads an init segment with no sound track as having none', function () {
    const silent = configurationOfInit(configuredInit(parameterSetNals(1)))
    expect(silent?.parameterSets).length(3)
    expect(silent?.sound).equals(undefined)
  })

  it('finds no sound in an esds without a decoder configuration', function () {
    const init = configuredInit(parameterSetNals(1), SOUND)
    // The tag of the configuration, which comes after its length's own byte.
    init[init.indexOf(SOUND) - 2] = 7
    const config = configurationOfInit(init)
    expect(config?.parameterSets).length(3)
    expect(config?.sound).equals(undefined)
  })

  it('leaves out anything that is not a parameter set', function () {
    const sei = Buffer.from([39 << 1, 1, 9])
    const withSei = configurationOfInit(
      configuredInit([...parameterSetNals(1), sei])
    )
    expect(withSei?.parameterSets).deep.equals(held.parameterSets)
  })

  it('says nothing of an init segment with no hvcC, or a damaged one', function () {
    expect(configurationOfInit(Buffer.alloc(0))).equals(undefined)
    expect(configurationOfInit(Buffer.from('not a box'))).equals(undefined)
    const damaged = hevcInit()
    const hvcC = damaged.indexOf(Buffer.from('hvcC', 'latin1'))
    damaged[hvcC + 4 + 22] = 40
    expect(configurationOfInit(damaged)).equals(undefined)
  })

  for (const kind of ['classic', 'enhanced'] as const) {
    it(`finds the record in a ${kind} sequence header`, function () {
      const body = hevcHeaderBody(kind, parameterSetNals(1))
      expect(publishDiffers(held, { hevcHeader: hevcHeaderOf(body) })).equals(
        false
      )
      const other = hevcHeaderBody(kind, parameterSetNals(2))
      expect(publishDiffers(held, { hevcHeader: hevcHeaderOf(other) })).equals(
        true
      )
    })
  }

  it('takes nothing else for a sequence header', function () {
    expect(hevcHeaderOf(undefined)).equals(undefined)
    expect(hevcHeaderOf(Buffer.from([0x1c, 0, 0, 0, 0]))).equals(undefined)
    const coded = hevcHeaderBody('classic', parameterSetNals(1))
    coded[1] = 1
    expect(hevcHeaderOf(coded), 'a picture').equals(undefined)
    const h264 = hevcHeaderBody('classic', parameterSetNals(1))
    h264[0] = 0x17
    expect(hevcHeaderOf(h264), 'H.264').equals(undefined)
    const av1 = hevcHeaderBody('enhanced', parameterSetNals(1))
    av1.write('av01', 1, 'latin1')
    expect(hevcHeaderOf(av1), 'another fourcc').equals(undefined)
    const framePacket = hevcHeaderBody('enhanced', parameterSetNals(1))
    framePacket[0] = 0x91
    expect(hevcHeaderOf(framePacket), 'a coded frame').equals(undefined)
  })

  it('reads an AAC sequence header and nothing else', function () {
    expect(soundHeaderOf(soundHeaderBody(SOUND))?.equals(SOUND)).equals(true)
    expect(soundHeaderOf(undefined)).equals(undefined)
    expect(soundHeaderOf(Buffer.from([0xaf, 0]))).equals(undefined)
    expect(soundHeaderOf(Buffer.from([0xaf, 1, 1])), 'sound').equals(undefined)
    expect(soundHeaderOf(Buffer.from([0x2f, 0, 1])), 'MP3').equals(undefined)
  })

  it('has nothing to say a publish matches before a header arrives', function () {
    expect(publishDiffers(held, {})).equals(true)
  })

  it('takes an unreadable header for a difference', function () {
    const cut = hevcHeaderOf(
      hevcHeaderBody('classic', parameterSetNals(1))
    )!.subarray(0, 26)
    expect(publishDiffers(held, { hevcHeader: cut })).equals(true)
  })

  const header = hevcHeaderOf(hevcHeaderBody('classic', parameterSetNals(1)))

  it('compares sound when both sides have shown it', function () {
    expect(
      publishDiffers(held, { hevcHeader: header, soundHeader: SOUND })
    ).equals(false)
    expect(
      publishDiffers(held, { hevcHeader: header, soundHeader: OTHER_SOUND })
    ).equals(true)
  })

  it('waits for sound that may yet come, and believes metadata saying none will', function () {
    expect(publishDiffers(held, { hevcHeader: header })).equals(false)
    expect(
      publishDiffers(held, { hevcHeader: header, says: { noSound: false } })
    ).equals(false)
    expect(
      publishDiffers(held, { hevcHeader: header, says: { noSound: true } })
    ).equals(true)
  })

  it('ignores sound the recording never had', function () {
    const silent = configurationOfInit(configuredInit(parameterSetNals(1)))!
    expect(
      publishDiffers(silent, { hevcHeader: header, soundHeader: SOUND })
    ).equals(false)
  })
})

describe('the silence for a publish with no sound', function () {
  const none = { says: { noSound: true } }

  it("matches the recording's sample rate and channels", function () {
    expect(silenceFor(SOUND, none)).deep.equals({
      sampleRate: 48000,
      channelLayout: 'stereo'
    })
    expect(silenceFor(Buffer.from([0x12, 0x08]), none)).deep.equals({
      sampleRate: 44100,
      channelLayout: 'mono'
    })
    expect(silenceFor(Buffer.from([0x11, 0xb0]), none)).deep.equals({
      sampleRate: 48000,
      channelLayout: '5.1'
    })
  })

  it('falls back to 48 kHz stereo for a spelling it cannot read', function () {
    // A rate given in full, and channels left to a program config element.
    expect(silenceFor(Buffer.from([0x17, 0x80]), none)).deep.equals({
      sampleRate: 48000,
      channelLayout: 'stereo'
    })
  })

  it('is for a recording with sound and a publish that said it has none', function () {
    expect(silenceFor(undefined, none), 'a recording with none').equals(
      undefined
    )
    expect(silenceFor(Buffer.from([0x11]), none), 'unreadable').equals(
      undefined
    )
    expect(silenceFor(SOUND, {}), 'not heard yet').equals(undefined)
    expect(
      silenceFor(SOUND, { says: { noSound: false } }),
      'it says it has sound'
    ).equals(undefined)
    expect(
      silenceFor(SOUND, { soundHeader: SOUND, ...none }),
      'its header outranks its metadata'
    ).equals(undefined)
  })
})
