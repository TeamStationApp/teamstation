import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Platform } from 'react-native'

import { byLabel, render, settle, unmount } from '../../test/tessTestKit'
import { Composer, type ComposerProps, FIELD_NATIVE_ID } from './Composer'

const web = Platform.OS
beforeEach(() => {
  Platform.OS = 'ios'
})
afterEach(async () => {
  await unmount()
  Platform.OS = web
})

interface Fiber {
  memoizedProps?: Record<string, any>
  return?: Fiber | null
  alternate?: Fiber | null
}

/**
 * The props React holds for the field's `TextInput`, past the DOM it draws,
 * as last drawn: of the two copies React keeps, the one with the value the
 * DOM shows.
 */
function fieldProps(): Record<string, any> {
  const node = byLabel('Ask Tess') as HTMLTextAreaElement
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  const host = (node as unknown as Record<string, Fiber>)[key]
  const propsFrom = (start: Fiber | null | undefined): Record<string, any> => {
    let fiber = start
    while (fiber != null && fiber.memoizedProps?.returnKeyType == null)
      fiber = fiber.return
    return fiber?.memoizedProps ?? {}
  }
  const props = propsFrom(host)
  return props.value === node.value ? props : propsFrom(host.alternate)
}

describe("Tess's composer on a phone or a tablet", () => {
  it('sends on return, and keeps a line break a hardware Shift+Return puts in', async () => {
    const sent: string[] = []
    const props: ComposerProps = {
      busy: false,
      onSend: async text => {
        sent.push(text)
        return true
      },
      onUpload: async () => null,
      onError: () => undefined
    }
    await render(<Composer {...props} />)
    const field = fieldProps()
    // Return, on the screen's keyboard or a hardware one, sends; nothing is
    // left to the web's Enter handling.
    expect(field.multiline).equals(true)
    expect(field.returnKeyType).equals('send')
    expect(field.submitBehavior).equals('submit')
    // No line cap: rows would become numberOfLines and hold it to one line.
    expect(field.rows).equals(undefined)
    expect(field.numberOfLines).equals(undefined)
    // The one field iOS's Shift+Return newline acts on, by the name
    // TSShiftReturn.m looks for on the field's host view.
    expect(field.nativeID).equals(FIELD_NATIVE_ID)
    expect(FIELD_NATIVE_ID).equals('tessComposerField')
    let prevented = false
    act(() => {
      field.onKeyPress({
        nativeEvent: { key: 'Enter' },
        preventDefault: () => {
          prevented = true
        }
      })
    })
    expect(prevented).equals(false)
    // Shift+Return arrives as a change that holds a line break, as a paste
    // does (TSShiftReturn.m): kept, with nothing sent.
    act(() => {
      fieldProps().onChangeText('a\nb')
    })
    await settle()
    expect(sent).deep.equals([])
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('a\nb')
    // Return then sends both lines, and empties the field natively, so a
    // grown field measures itself again.
    const node = byLabel('Ask Tess') as HTMLTextAreaElement & {
      clear: () => void
    }
    const clear = node.clear.bind(node)
    let cleared = 0
    node.clear = () => {
      cleared += 1
      clear()
    }
    act(() => {
      fieldProps().onSubmitEditing()
    })
    await settle()
    expect(sent).deep.equals(['a\nb'])
    expect(cleared).equals(1)
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
  })
})
