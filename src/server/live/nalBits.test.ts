import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  Bits,
  BitWriter,
  skipProfileTierLevel,
  toPayload,
  toRbsp
} from './nalBits'

describe('NAL unit bits', function () {
  it('takes emulation prevention bytes out and puts them back', function () {
    const payload = Buffer.from([0x42, 0, 0, 3, 1, 0, 0, 3, 0, 5, 0, 0, 3, 3])
    const rbsp = toRbsp(payload)
    expect([...rbsp]).deep.equals([0x42, 0, 0, 1, 0, 0, 0, 5, 0, 0, 3])
    expect([...toPayload(rbsp)]).deep.equals([...payload])
  })

  it('protects a payload that ends in a zero', function () {
    expect([...toPayload(Buffer.from([5, 0]))]).deep.equals([5, 0, 3])
  })

  it('writes and reads fixed fields and exp-Golomb codes', function () {
    const out = new BitWriter()
    out.u(3, 5)
    out.ue(0)
    out.ue(1)
    out.ue(6)
    out.ue(255)
    out.u(1, 1)
    out.align()
    const bits = new Bits(out.bytes())
    expect(bits.u(3)).equals(5)
    expect([bits.ue(), bits.ue(), bits.ue(), bits.ue()]).deep.equals([
      0, 1, 6, 255
    ])
    expect(bits.u(1)).equals(1)
    // The stop bit sits right after the fields.
    expect(bits.stopBit()).equals(bits.pos)
  })

  it('reads signed exp-Golomb codes', function () {
    // ue 1, 2, 3, 4 are se +1, -1, +2, -2.
    const out = new BitWriter()
    for (const code of [1, 2, 3, 4]) out.ue(code)
    out.align()
    const bits = new Bits(out.bytes())
    expect([bits.se(), bits.se(), bits.se(), bits.se()]).deep.equals([
      1, -1, 2, -2
    ])
  })

  it('copies a run of bits from a reader at any offset', function () {
    const source = new Bits(Buffer.from([0b10110011, 0b01000000]))
    const out = new BitWriter()
    out.copy(source, 2, 10)
    expect([...out.bytes()]).deep.equals([0b11001101])
    source.skip(9)
    expect(source.bit()).equals(1)
  })

  it('says when a parameter set ends early or has no stop bit', function () {
    expect(() => new Bits(Buffer.from([0])).u(9)).throws(/ends early/)
    expect(() => new Bits(Buffer.alloc(2)).ue()).throws(/ends early/)
    expect(() => new Bits(Buffer.from([0, 0, 0, 0, 0, 1])).ue()).throws(
      /bad exp-Golomb/
    )
    expect(() => new Bits(Buffer.alloc(2)).stopBit()).throws(/no stop bit/)
  })

  it('reads past an HEVC profile_tier_level and what its sub-layers add', function () {
    const out = new BitWriter()
    out.u(32, 0)
    out.u(32, 0)
    out.u(32, 0)
    // Two sub-layers: the first with a profile and a level, the second a level.
    out.u(1, 1)
    out.u(1, 1)
    out.u(1, 0)
    out.u(1, 1)
    out.u(12, 0)
    out.u(32, 0)
    out.u(32, 0)
    out.u(24, 0)
    out.u(8, 0)
    out.u(8, 0)
    out.ue(41)
    out.align()
    const bits = new Bits(out.bytes())
    skipProfileTierLevel(bits, 2)
    expect(bits.ue()).equals(41)
  })
})
