import { expect } from 'chai'
import { describe, it } from 'mocha'

import { pickedFileOf } from './pickedFiles'

describe('a picked sponsor file', () => {
  it('keeps the file’s name, type and size, with an object URL for it', () => {
    const file = new window.File([new Uint8Array(64)], 'Bayside Bakery.png', {
      type: 'image/png'
    })
    const made: Blob[] = []
    const picked = pickedFileOf(file, {
      createObjectURL: blob => {
        made.push(blob)
        return 'blob:http://localhost/bayside'
      }
    })
    expect(picked).deep.equals({
      name: 'Bayside Bakery.png',
      type: 'image/png',
      size: 64,
      url: 'blob:http://localhost/bayside'
    })
    expect(made).deep.equals([file])
  })

  it('uses the browser’s own object URLs by default', () => {
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:http://localhost/default'
    })
    try {
      const file = new window.File(['x'], 'logo.png', { type: 'image/png' })
      expect(pickedFileOf(file).url).equals('blob:http://localhost/default')
    } finally {
      if (original == null) Reflect.deleteProperty(URL, 'createObjectURL')
      else Object.defineProperty(URL, 'createObjectURL', original)
    }
  })
})
