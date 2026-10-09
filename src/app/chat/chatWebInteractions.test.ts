import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS,
  MAX_BODY
} from '../../common/chatContent'
import { attachmentProblem, sendAllowed } from './chatComposeModel'
import { pickFiles, readPicked } from './chatFiles'
import type { PickedFile } from './chatFileTypes'
import { bindComposerKeys } from './chatWebInteractions'
import { bindComposerKeys as bindNativeComposerKeys } from './chatWebInteractions.native'

const originalPointer = Object.getOwnPropertyDescriptor(
  globalThis,
  'matchMedia'
)
let stop: (() => void) | undefined
afterEach(function () {
  stop?.()
  stop = undefined
  if (originalPointer != null)
    Object.defineProperty(globalThis, 'matchMedia', originalPointer)
  else Reflect.deleteProperty(globalThis, 'matchMedia')
})

const prepared = (fileName = 'notes.pdf'): PickedFile => ({
  fileName,
  contentType: 'application/pdf',
  bytes: new Uint8Array([1])
})
function file(
  fileName: string,
  size: number,
  read: () => Promise<ArrayBuffer>
): File {
  const chosen = new File([], fileName, { type: 'application/pdf' })
  Object.defineProperty(chosen, 'size', { value: size })
  chosen.arrayBuffer = read
  return chosen
}

describe('chat desktop send eligibility', function () {
  const state = {
    enabled: true,
    sending: false,
    preparing: false,
    text: ' Draft body ',
    attachments: [] as PickedFile[]
  }
  it('requires a usable nonempty draft and applies sending, preparation and encrypted-content limits', function () {
    expect(sendAllowed(state)).equals(true)
    expect(sendAllowed({ ...state, text: ' \n ' })).equals(false)
    expect(
      sendAllowed({ ...state, text: '', attachments: [prepared()] })
    ).equals(true)
    for (const patch of [
      { enabled: false },
      { sending: true },
      { preparing: true }
    ])
      expect(sendAllowed({ ...state, ...patch })).equals(false)
    expect(sendAllowed({ ...state, text: 'a'.repeat(MAX_BODY) })).equals(true)
    expect(sendAllowed({ ...state, text: 'a'.repeat(MAX_BODY + 1) })).equals(
      false
    )
    expect(
      sendAllowed({
        ...state,
        attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () =>
          prepared()
        )
      })
    ).equals(false)
    const bytes = Object.create(Uint8Array.prototype) as Uint8Array
    Object.defineProperty(bytes, 'length', { value: MAX_ATTACHMENT_SIZE + 1 })
    expect(
      sendAllowed({ ...state, attachments: [{ ...prepared(), bytes }] })
    ).equals(false)
  })

  it('validates aggregate capacity and the exact100MiB boundary by metadata', function () {
    expect(
      attachmentProblem([{ fileName: 'large.pdf', size: MAX_ATTACHMENT_SIZE }])
    ).equals(undefined)
    expect(
      attachmentProblem([
        { fileName: 'large.pdf', size: MAX_ATTACHMENT_SIZE + 1 }
      ])
    ).equals('large.pdf is too large: files can be at most 100 MB.')
    expect(
      attachmentProblem(
        [
          { fileName: 'first.pdf', size: 1 },
          { fileName: 'second.pdf', size: 1 }
        ],
        1
      )
    ).equals('A message can include up to 10 attachments.')
    expect(attachmentProblem([], 0)).equals(undefined)
  })
})

describe('chat desktop composer keyboard adapter', function () {
  function mount(fine = true): {
    input: HTMLTextAreaElement
    sends: () => number
  } {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: fine })
    })
    const input = document.createElement('textarea')
    document.body.append(input)
    let sent = 0
    stop = bindComposerKeys(input, () => {
      sent += 1
    })
    return { input, sends: () => sent }
  }
  function key(
    input: HTMLElement,
    over: KeyboardEventInit = {}
  ): KeyboardEvent {
    const event = new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...over
    })
    input.dispatchEvent(event)
    return event
  }

  it('sends once for desktop Enter and suppresses repeating the held key', function () {
    const { input, sends } = mount()
    expect(key(input).defaultPrevented).equals(true)
    expect(sends()).equals(1)
    expect(key(input, { repeat: true }).defaultPrevented).equals(true)
    expect(sends()).equals(1)
    expect(key(input, { key: 'a' }).defaultPrevented).equals(false)
    expect(key(input, { shiftKey: true }).defaultPrevented).equals(false)
    expect(sends()).equals(1)
    stop?.()
    expect(key(input).defaultPrevented).equals(false)
    expect(sends()).equals(1)
  })

  it('leaves tracked composition, isComposing and legacy229 confirmation to the IME', function () {
    const { input, sends } = mount()
    input.dispatchEvent(new window.Event('compositionstart'))
    expect(key(input).defaultPrevented).equals(false)
    input.dispatchEvent(new window.Event('compositionend'))
    expect(key(input, { isComposing: true }).defaultPrevented).equals(false)
    expect(key(input, { keyCode: 229 }).defaultPrevented).equals(false)
    expect(sends()).equals(0)
    key(input)
    expect(sends()).equals(1)
    stop?.()
    input.dispatchEvent(new window.Event('compositionstart'))
    input.dispatchEvent(new window.Event('compositionend'))
    expect(sends()).equals(1)
  })

  it('preserves a touch browser and the native keyboard, including when no DOM view exists', function () {
    const { input, sends } = mount(false)
    expect(key(input).defaultPrevented).equals(false)
    expect(sends()).equals(0)
    stop?.()
    stop = undefined
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    let nativeSent = 0
    const nativeStop = bindNativeComposerKeys(input, () => {
      nativeSent += 1
    })
    expect(key(input).defaultPrevented).equals(false)
    nativeStop()
    expect(nativeSent).equals(0)
    expect(() => {
      bindComposerKeys(undefined, () => {})()
    }).not.throws()
  })
})

describe('chat desktop file preparation', function () {
  it('rejects excess count and existing-draft capacity before reading any bytes', async function () {
    let reads = 0
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) =>
      file(`notes-${index}.pdf`, 1, async () => {
        reads += 1
        return new Uint8Array([1]).buffer
      })
    )
    for (const [chosen, remaining] of [
      [files, MAX_ATTACHMENTS],
      [files.slice(0, 2), 1]
    ] as const) {
      let failure: unknown
      await readPicked(chosen, undefined, remaining).catch((error: unknown) => {
        failure = error
      })
      expect(String(failure)).contains('up to 10 attachments')
    }
    expect(reads).equals(0)
  })

  it('rejects an oversized selection before reading even its preceding valid file', async function () {
    let reads = 0
    const read = async (): Promise<ArrayBuffer> => {
      reads += 1
      return new Uint8Array([1]).buffer
    }
    let failure: unknown
    await readPicked([
      file('valid.pdf', 1, read),
      file('huge.pdf', MAX_ATTACHMENT_SIZE + 1, read)
    ]).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).contains('huge.pdf is too large')
    expect(reads).equals(0)
    expect(
      await readPicked([file('boundary.pdf', MAX_ATTACHMENT_SIZE, read)])
    ).length(1)
    expect(reads).equals(1)
  })

  it('preserves original file order and fails without returning a partial result after a read error', async function () {
    const files = [
      file('first.pdf', 1, async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return new Uint8Array([1]).buffer
      }),
      file('second.pdf', 1, async () => new Uint8Array([2]).buffer)
    ]
    expect(
      (await readPicked(files)).map(chosen => [
        chosen.fileName,
        [...chosen.bytes]
      ])
    ).deep.equals([
      ['first.pdf', [1]],
      ['second.pdf', [2]]
    ])
    let failure: unknown
    await readPicked([
      files[0],
      file('unreadable.pdf', 1, async () => {
        throw new Error('Read unavailable')
      })
    ]).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).contains('Read unavailable')
  })

  it('applies the same remaining-count validation through the browser attachment picker and cleans up on cancel', async function () {
    let reads = 0
    const selected = [
      file('first.pdf', 1, async () => {
        reads += 1
        return new Uint8Array([1]).buffer
      }),
      file('second.pdf', 1, async () => {
        reads += 1
        return new Uint8Array([2]).buffer
      })
    ]
    const result = pickFiles('files', 1)
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: selected })
    input.dispatchEvent(new window.Event('change'))
    let failure: unknown
    await result.catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).contains('up to 10 attachments')
    expect(reads).equals(0)
    expect(document.querySelector('input[type="file"]')).equals(null)
    const cancelled = pickFiles('files', document)
    document
      .querySelector('input[type="file"]')!
      .dispatchEvent(new window.Event('cancel'))
    expect(await cancelled).deep.equals([])
    expect(document.querySelector('input[type="file"]')).equals(null)
  })
})
