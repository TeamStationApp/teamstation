/**
 * Reading and writing the bits of H.264 and HEVC NAL units.
 *
 * A NAL unit's payload is its raw byte sequence (RBSP) with an emulation
 * prevention byte after every two zeros that a 0, 1, 2 or 3 follows, so no
 * start code appears inside it. Parameter sets and slice headers are read and
 * written as bits of the RBSP: fixed-width fields and exp-Golomb codes.
 */

/** A NAL unit's payload with its emulation prevention bytes taken out. */
export function toRbsp(payload: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < payload.length; i++) {
    if (
      i >= 2 &&
      payload[i] === 3 &&
      payload[i - 1] === 0 &&
      payload[i - 2] === 0 &&
      out.length >= 2 &&
      out[out.length - 1] === 0 &&
      out[out.length - 2] === 0
    ) {
      continue
    }
    out.push(payload[i])
  }
  return Buffer.from(out)
}

/** An RBSP with emulation prevention bytes put in, as a NAL unit's payload. */
export function toPayload(rbsp: Buffer): Buffer {
  const out: number[] = []
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  if (out[out.length - 1] === 0) out.push(3)
  return Buffer.from(out)
}

/** Reads an RBSP bit by bit, most significant first. */
export class Bits {
  pos = 0
  constructor(readonly data: Buffer) {}
  bit(): number {
    const byte = this.data[this.pos >> 3]
    if (byte == null) throw new Error('parameter set ends early')
    const value = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return value
  }

  u(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.bit()
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error('bad exp-Golomb code')
    }
    return 2 ** zeros - 1 + this.u(zeros)
  }

  se(): number {
    const value = this.ue()
    return value % 2 === 1 ? (value + 1) / 2 : -(value / 2)
  }

  skip(n: number): void {
    this.pos += n
  }

  /** Where the stop bit of the RBSP trailing bits is. */
  stopBit(): number {
    for (let at = this.data.length * 8 - 1; at >= 0; at--) {
      if (((this.data[at >> 3] >> (7 - (at & 7))) & 1) === 1) return at
    }
    throw new Error('no stop bit')
  }
}

/** Writes an RBSP bit by bit. */
export class BitWriter {
  private readonly bits: number[] = []
  u(n: number, value: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / 2 ** i) % 2)
    }
  }

  ue(value: number): void {
    const code = value + 1
    const length = Math.floor(Math.log2(code))
    this.u(length, 0)
    this.u(length + 1, code)
  }

  /** The bits of `from` from `start` up to, not including, `end`. */
  copy(from: Bits, start: number, end: number): void {
    const reader = new Bits(from.data)
    reader.pos = start
    while (reader.pos < end) this.bits.push(reader.bit())
  }

  /** A stop bit and zeros to the next byte. */
  align(): void {
    this.bits.push(1)
    while (this.bits.length % 8 !== 0) this.bits.push(0)
  }

  bytes(): Buffer {
    const out = Buffer.alloc(this.bits.length / 8)
    this.bits.forEach((bit, i) => {
      if (bit === 1) out[i >> 3] |= 0x80 >> (i & 7)
    })
    return out
  }
}
