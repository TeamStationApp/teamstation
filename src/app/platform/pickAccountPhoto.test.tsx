import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { pickAccountPhoto } from './pickAccountPhoto'

const original = globalThis.FileReader
const input = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[type="file"]')!
afterEach(() => {
  globalThis.FileReader = original
  document.body.replaceChildren()
})
describe('browser account photo picker', () => {
  it('cleans up cancellation and empty selections', async () => {
    let chosen = pickAccountPhoto()
    input().dispatchEvent(new window.Event('cancel'))
    expect(await chosen).equals(null)
    expect(input()).equals(null)
    chosen = pickAccountPhoto()
    input().dispatchEvent(new window.Event('change'))
    expect(await chosen).equals(null)
  })
  it('rejects invalid selections and reads image bytes', async () => {
    const select = (type: string, size: number): void => {
      Object.defineProperty(input(), 'files', { value: [{ type, size }] })
      input().dispatchEvent(new window.Event('change'))
    }
    let chosen = pickAccountPhoto()
    select('text/plain', 5)
    try {
      await chosen
      throw new Error('expected failure')
    } catch (error) {
      expect((error as Error).message).includes('JPEG')
    }
    let mode: 'ok' | 'error' | 'bad' = 'ok'
    class Reader {
      result: string | undefined
      onload?: () => void
      onerror?: () => void
      readAsDataURL(): void {
        if (mode === 'error') this.onerror?.()
        else {
          this.result =
            mode === 'bad' ? 'invalid' : 'data:image/png;base64,AAAA'
          this.onload?.()
        }
      }
    }
    globalThis.FileReader = Reader as unknown as typeof FileReader
    chosen = pickAccountPhoto()
    select('image/png', 3)
    expect(await chosen).deep.equals({
      contentType: 'image/png',
      base64: 'AAAA'
    })
    for (const next of ['error', 'bad'] as const) {
      mode = next
      chosen = pickAccountPhoto()
      select('image/png', 3)
      try {
        await chosen
        throw new Error('expected failure')
      } catch (error) {
        expect((error as Error).message).includes('could not be read')
      }
    }
  })
})
