import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Keyboard,
  type KeyboardEvent as NativeKeyboardEvent,
  Platform
} from 'react-native'

import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import type { ChatBounds } from './chatInteractionModel'
import type { MessageSource } from './chatMessageSource'
import { ChatOverlayHost } from './ChatOverlayHost'
import { watchReducedTransparency } from './chatTransparency'
import { watchReducedTransparency as watchNativeTransparency } from './chatTransparency.native'
import { chat, member, message } from './chatViews.test.helpers'
import {
  MessageActionOverlay,
  type MessageActionOverlayProps
} from './MessageActionOverlay'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { MessageMenu, type MessageMenuProps } from './MessageMenu'

let root: Root | undefined
let host: HTMLElement | undefined
const stops: Array<() => void> = []
const replaced = [
  [Animated, 'timing'],
  [AccessibilityInfo, 'isReduceMotionEnabled'],
  [AccessibilityInfo, 'isReduceTransparencyEnabled'],
  [AccessibilityInfo, 'addEventListener'],
  [BackHandler, 'addEventListener'],
  [Keyboard, 'addListener'],
  [Keyboard, 'metrics'],
  [Keyboard, 'dismiss'],
  [Platform, 'OS'],
  [window, 'matchMedia'],
  [window, 'Image'],
  [globalThis, 'matchMedia'],
  [document.documentElement, 'clientWidth'],
  [document.documentElement, 'clientHeight']
] as const
const originals = replaced.map(([target, key]) => ({
  target,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key)
}))
/** The React Native props of the View that rendered a DOM node. */
const hostViewProps = (node: HTMLElement): Record<string, unknown> => {
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber'))!
  let fiber = (node as unknown as Record<string, FiberNode>)[key]
  while (!('importantForAccessibility' in (fiber.memoizedProps ?? {})))
    fiber = fiber.return!
  return fiber.memoizedProps
}
interface FiberNode {
  memoizedProps: Record<string, unknown>
  return?: FiberNode
}
/** A spotlight part's animated layer: its fade and motion live there. */
const layerOf = (part: HTMLElement): HTMLElement =>
  part.firstElementChild as HTMLElement
/** Whether a part's layer is offset toward its source, not at rest. */
const moved = (part: HTMLElement): boolean =>
  /translate[XY]\((?!0px\))/.test(layerOf(part).style.transform)
let reduced = false
let animations: Array<{
  config: Animated.TimingAnimationConfig
  value: Animated.Value
  end?: (result: { finished: boolean }) => void
  stopped: boolean
}>

describe('chat message presentation', function () {
  beforeEach(function () {
    reduced = false
    animations = []
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false })
    })
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 390
    })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 844
    })
    window.dispatchEvent(new window.Event('resize'))
    AccessibilityInfo.isReduceMotionEnabled = async () => reduced
    AccessibilityInfo.isReduceTransparencyEnabled = async () => false
    AccessibilityInfo.addEventListener = () => ({ remove: () => {} })
    const timing: typeof Animated.timing = (value, config) => {
      const animation: (typeof animations)[number] = {
        config,
        value: value as Animated.Value,
        stopped: false
      }
      animations.push(animation)
      return {
        start: end => {
          animation.end = end
        },
        stop: () => {
          animation.stopped = true
        },
        reset: () => {}
      }
    }
    Object.defineProperty(Animated, 'timing', {
      configurable: true,
      writable: true,
      value: timing
    })
  })
  afterEach(async function () {
    for (const stop of stops.splice(0)) stop()
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    host = undefined
    for (const { target, key, descriptor } of originals) {
      if (descriptor == null) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    }
    window.dispatchEvent(new window.Event('resize'))
  })
  async function render(element: React.ReactElement): Promise<HTMLElement> {
    if (root == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(<ThemeProvider>{element}</ThemeProvider>)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    return host!
  }
  const bounds: ChatBounds = { x: 42, y: 300, width: 210, height: 90 }
  const source: MessageSource = {
    bounds,
    measure: accept => {
      accept(bounds)
      return () => {}
    }
  }
  const fileOps = {
    bytesUri: async () => 'blob:fixture',
    releaseUri: async () => {},
    saveFile: async () => {}
  }
  const bubble = (
    over: Partial<MessageBubbleProps> = {}
  ): MessageBubbleProps => ({
    message: message({ senderName: 'Trea Turner' }),
    conversation: chat(),
    members: [member(userIdOfGumbo(2), 'Trea Turner')],
    engine: { openAttachment: async () => new Uint8Array() },
    files: fileOps,
    maxWidth: 210,
    swipe: false,
    onLongPress: () => {},
    onReply: () => {},
    onToggleReaction: () => {},
    ...over
  })
  const menu = (over: Partial<MessageMenuProps> = {}): MessageMenuProps => ({
    message: message({ senderName: 'Trea Turner' }),
    actions: ['reply', 'react', 'copy', 'pin', 'deleteForEveryone'],
    source,
    onReply: () => {},
    onReact: () => {},
    onMoreEmoji: () => {},
    onCopy: async () => {},
    onPin: () => {},
    onDelete: () => {},
    onClose: () => {},
    ...over
  })
  function button(label: string): HTMLElement {
    const found = [
      ...host!.querySelectorAll<HTMLElement>('[role="button"],button')
    ].find(
      value =>
        value.getAttribute('aria-label') === label ||
        (value.getAttribute('aria-label') == null &&
          value.textContent?.endsWith(label) === true)
    )
    expect(found, label).not.equals(undefined)
    return found!
  }
  function keyboardEvent(screenY: number): NativeKeyboardEvent {
    const coordinates = {
      screenX: 0,
      screenY,
      width: 390,
      height: 844 - screenY
    }
    return {
      duration: 0,
      easing: 'keyboard',
      startCoordinates: coordinates,
      endCoordinates: coordinates,
      isEventFromThisApp: true
    }
  }
  function keyboardListeners(): Map<
    string,
    (event: NativeKeyboardEvent) => void
  > {
    const callbacks = new Map<string, (event: NativeKeyboardEvent) => void>()
    Object.defineProperty(Keyboard, 'addListener', {
      configurable: true,
      writable: true,
      value: (event: string, accept: (event: NativeKeyboardEvent) => void) => {
        callbacks.set(event, accept)
        return {
          remove: () => {
            callbacks.delete(event)
          }
        }
      }
    })
    return callbacks
  }
  async function press(label: string): Promise<void> {
    await act(async () => {
      button(label).click()
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
  async function finish(): Promise<void> {
    await act(async () => {
      const animation = animations.at(-1)!
      animation.value.setValue(animation.config.toValue as number)
      animation.end?.({ finished: true })
      await Promise.resolve()
    })
  }
  const overlay = (
    over: Partial<MessageActionOverlayProps> = {}
  ): MessageActionOverlayProps => ({
    selected: <div>Selected words</div>,
    children: <button aria-label="Allowed action">Allowed action</button>,
    reactions: <button aria-label="Reaction">Reaction</button>,
    source,
    mine: false,
    label: 'Message actions',
    closing: false,
    onClose: () => {},
    onClosed: () => {},
    ...over
  })

  describe('chat incoming avatar lane and safe selected clone', function () {
    it('reuses the displayed picture while the original owns its one URI and invalidates stale snapshots', async function () {
      const ImageConstructor = window.Image
      Object.defineProperty(window, 'Image', {
        configurable: true,
        value: function () {
          const image = new ImageConstructor()
          Object.defineProperty(image, 'src', {
            configurable: true,
            get: () => image.getAttribute('src') ?? '',
            set: (value: string) => {
              image.setAttribute('src', value)
              setTimeout(() => image.onload?.(new window.Event('load')), 0)
            }
          })
          return image
        }
      })
      const photo = {
        id: 'cat_photo',
        key: 'A'.repeat(43),
        digest: 'A'.repeat(43),
        size: 1,
        contentType: 'image/jpeg',
        fileName: 'photo.jpg',
        width: 640,
        height: 480
      }
      let opens = 0
      let urls = 0
      const released: string[] = []
      let captured: MessageSource | undefined
      const original = bubble({
        message: message({ attachments: [photo] }),
        engine: {
          openAttachment: async () => {
            opens += 1
            return new Uint8Array([1])
          }
        },
        files: {
          ...fileOps,
          bytesUri: async () => {
            urls += 1
            return 'blob:displayed-photo'
          },
          releaseUri: async uri => {
            released.push(uri)
          }
        },
        onLongPress: (_message, _anchor, origin) => {
          captured = origin
        }
      })
      let node = await render(
        <>
          <MessageBubble key="original" {...original} />
        </>
      )
      const target = node.querySelector('[data-testid="chat-bubble-msg_1"]')!
      Object.defineProperty(target, 'measureInWindow', {
        configurable: true,
        value: (
          accept: (x: number, y: number, w: number, h: number) => void
        ) => {
          accept(42, 300, 210, 90)
        }
      })
      await press('More message actions')
      const snapshot = captured!.pictures!()
      expect(snapshot!.get(photo.id)?.valid()).equals(true)
      node = await render(
        <>
          <MessageBubble key="original" {...original} />
          <MessageBubble
            key="selected"
            {...original}
            selected
            actions={[]}
            pictures={snapshot}
          />
        </>
      )
      expect(
        [...node.querySelectorAll('img')].filter(
          image => image.src === 'blob:displayed-photo'
        )
      ).length(2)
      expect(opens).equals(1)
      expect(urls).equals(1)
      expect(released).deep.equals([])
      expect(node.querySelector('video,audio')).equals(null)
      await render(
        <>
          <MessageBubble
            key="original"
            {...original}
            message={message({ attachments: [] })}
          />
          <MessageBubble
            key="selected"
            {...original}
            selected
            actions={[]}
            pictures={snapshot}
          />
        </>
      )
      expect(released).deep.equals(['blob:displayed-photo'])
      // A second render observes the original's completed snapshot teardown.
      node = await render(
        <MessageBubble
          {...original}
          selected
          actions={[]}
          pictures={snapshot}
        />
      )
      expect(node.querySelector('img')).equals(null)
      expect(opens).equals(1)
      expect(urls).equals(1)
    })
    it('reserves the same incoming lane and places only the final run avatar beside the text bubble', async function () {
      let node = await render(
        <MessageBubble {...bubble({ showSenderAvatar: false })} />
      )
      const lane = node.querySelector<HTMLElement>(
        '[data-testid="chat-avatar-lane-msg_1"]'
      )!
      expect(getComputedStyle(lane).width).equals('28px')
      expect(lane.querySelector('[data-testid="chat-avatar"]')).equals(null)
      expect(node.textContent).contains('Trea Turner')
      node = await render(
        <MessageBubble {...bubble({ showSenderAvatar: true })} />
      )
      expect(
        node
          .querySelector('[data-testid="chat-avatar-lane-msg_1"]')!
          .querySelector('[aria-label="Trea Turner"]')
      ).not.equals(null)
      expect(
        getComputedStyle(
          node.querySelector('[data-testid="chat-bubble-msg_1"]')!
            .parentElement!
        ).alignItems
      ).equals('flex-end')
      node = await render(<MessageBubble {...bubble({ members: [] })} />)
      expect(
        node.querySelector('[data-testid="chat-avatar-lane-msg_1"]')!
          .textContent
      ).contains('FM')
      node = await render(
        <MessageBubble {...bubble({ message: message({ mine: true }) })} />
      )
      expect(node.querySelector('[data-testid^="chat-avatar-lane"]')).equals(
        null
      )
    })

    it('captures the bubble itself before opening and refuses a late result after scrolling', async function () {
      const captures: Array<MessageSource | undefined> = []
      const generation = { current: 0 }
      const node = await render(
        <MessageBubble
          {...bubble({
            gestureGeneration: generation,
            onLongPress: (_message, _anchor, origin) => captures.push(origin)
          })}
        />
      )
      const target = node.querySelector('[data-testid="chat-bubble-msg_1"]')!
      let deliver:
        | ((x: number, y: number, width: number, height: number) => void)
        | undefined
      Object.defineProperty(target, 'measureInWindow', {
        configurable: true,
        value: (accept: typeof deliver) => {
          deliver = accept
        }
      })
      await press('More message actions')
      expect(captures).deep.equals([])
      await act(async () => {
        deliver?.(42, 300, 210, 90)
      })
      expect(captures[0]?.bounds).deep.equals(bounds)
      await press('More message actions')
      generation.current += 1
      await act(async () => {
        deliver?.(42, 300, 210, 90)
      })
      expect(captures).length(1)
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      let reverse: ChatBounds | undefined = bounds
      captures[0]!.measure(value => {
        reverse = value
      })()
      expect(reverse).equals(undefined)
    })

    it('never opens attachments, creates media URLs or mounts playback for the sharp clone', async function () {
      let opens = 0
      let urls = 0
      const node = await render(
        <MessageBubble
          {...bubble({
            selected: true,
            actions: [],
            engine: {
              openAttachment: async () => {
                opens += 1
                return new Uint8Array()
              }
            },
            files: {
              ...fileOps,
              bytesUri: async () => {
                urls += 1
                return 'blob:fixture'
              }
            },
            message: message({
              attachments: [
                {
                  id: 'cat_photo',
                  key: 'A'.repeat(43),
                  digest: 'A'.repeat(43),
                  size: 1,
                  contentType: 'image/jpeg',
                  fileName: 'image.jpg',
                  width: 640,
                  height: 480
                },
                {
                  id: 'cat_clip',
                  key: 'A'.repeat(43),
                  digest: 'A'.repeat(43),
                  size: 1,
                  contentType: 'video/mp4',
                  fileName: 'clip.mp4',
                  width: 640,
                  height: 360
                }
              ]
            })
          })}
        />
      )
      expect(opens).equals(0)
      expect(urls).equals(0)
      expect(node.querySelector('video,audio')).equals(null)
      expect(node.querySelector('[data-testid^="chat-avatar-lane"]')).equals(
        null
      )
      expect(node.textContent).contains('Photo')
    })
  })

  describe('chat spotlight lifetime and accessibility', function () {
    it('fades a partially offscreen tall bubble at a bounded preview instead of lifting invisible content', async function () {
      const clipped = { x: 42, y: -2000, width: 210, height: 2400 }
      const tallSource: MessageSource = {
        bounds: clipped,
        measure: accept => {
          accept(clipped)
          return () => {}
        }
      }
      const node = await render(
        <ChatOverlayHost>
          <div data-testid="tall-history" style={{ overflow: 'scroll' }}>
            History
          </div>
          <MessageActionOverlay
            {...overlay({
              source: tallSource,
              selected: <div>{'Long message words '.repeat(500)}</div>
            })}
          />
        </ChatOverlayHost>
      )
      const history = node.querySelector<HTMLElement>(
        '[data-testid="tall-history"]'
      )!
      history.scrollTop = 137
      const preview = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-preview"]'
      )!
      const controls = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-controls"]'
      )!
      expect(moved(preview)).equals(false)
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0')
      expect(
        parseFloat(getComputedStyle(controls).top) +
          parseFloat(getComputedStyle(controls).height)
      ).at.most(844)
      expect(node.querySelector('[aria-label="Allowed action"]')).not.equals(
        null
      )
      expect(
        node.querySelectorAll('[data-testid="chat-message-spotlight-preview"]')
      ).length(1)
      expect(history.closest('[aria-hidden="true"]')).not.equals(null)
      await finish()
      expect(getComputedStyle(layerOf(preview)).opacity).equals('1')
      expect(history.scrollTop).equals(137)
    })

    it('lets a touch beside a long message reach the closing backdrop', async function () {
      // Seen in iOS E5: the controls covered the whole width, so a touch
      // beside a long preview reached nothing and only the status bar strip
      // was left to close the actions.
      const clipped = { x: 42, y: -2000, width: 210, height: 2400 }
      const tallSource: MessageSource = {
        bounds: clipped,
        measure: accept => {
          accept(clipped)
          return () => {}
        }
      }
      const node = await render(
        <ChatOverlayHost>
          <MessageActionOverlay
            {...overlay({
              source: tallSource,
              selected: <div>{'Long message words '.repeat(500)}</div>
            })}
          />
        </ChatOverlayHost>
      )
      const pointer = (id: string): string =>
        getComputedStyle(
          node.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
        ).pointerEvents
      expect(pointer('chat-message-spotlight-controls')).equals('none')
      expect(pointer('chat-message-spotlight-preview')).not.equals('none')
      expect(pointer('chat-message-spotlight-reactions')).not.equals('none')
      expect(
        node.querySelector('[role="button"][aria-label="Cancel"]')
      ).not.equals(null)
    })

    it('fades the return when a previously visible source becomes horizontally clipped', async function () {
      const returning: MessageSource = {
        bounds,
        measure: accept => {
          accept({ ...bounds, x: -40 })
          return () => {}
        }
      }
      let closed = 0
      const props = overlay({
        source: returning,
        onClosed: () => {
          closed += 1
        }
      })
      const node = await render(<MessageActionOverlay {...props} />)
      const preview = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-preview"]'
      )!
      expect(moved(preview)).equals(true)
      await finish()
      await render(<MessageActionOverlay {...props} closing />)
      expect(moved(preview)).equals(false)
      expect(getComputedStyle(layerOf(preview)).opacity).equals('1')
      await finish()
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0')
      expect(closed).equals(1)
    })

    it('keeps reactions and every action in the compact scroll panel, remeasures without dismissing the keyboard or moving history', async function () {
      const callbacks = keyboardListeners()
      let dismissed = 0
      Keyboard.dismiss = () => {
        dismissed += 1
      }
      Keyboard.metrics = () => ({
        screenX: 0,
        screenY: 64,
        width: 390,
        height: 780
      })
      const node = await render(
        <ChatOverlayHost>
          <div data-testid="short-history" style={{ overflow: 'scroll' }}>
            History
          </div>
          <MessageActionOverlay
            {...overlay({
              children: (
                <>
                  <button aria-label="First action">First action</button>
                  <button aria-label="Last action">Last action</button>
                </>
              )
            })}
          />
        </ChatOverlayHost>
      )
      const history = node.querySelector<HTMLElement>(
        '[data-testid="short-history"]'
      )!
      history.scrollTop = 137
      const panel = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-panel"]'
      )!
      expect(getComputedStyle(panel).height).equals('64px')
      expect(
        node.querySelector('[data-testid="chat-message-spotlight-preview"]')
      ).equals(null)
      expect(panel.querySelectorAll('[aria-label="Reaction"]')).length(1)
      expect(panel.querySelector('[aria-label="Last action"]')).not.equals(null)
      expect(
        [...panel.querySelectorAll('div')].some(
          value => getComputedStyle(value).overflowY === 'auto'
        )
      ).equals(true)
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
          cancelable: true
        })
      )
      expect(document.activeElement?.getAttribute('aria-label')).equals(
        'Last action'
      )
      await act(async () => {
        ;[...callbacks.values()][1](keyboardEvent(844))
      })
      expect(
        node.querySelector('[data-testid="chat-message-spotlight-preview"]')
      ).not.equals(null)
      expect(node.querySelectorAll('[aria-label="Reaction"]')).length(1)
      expect(history.scrollTop).equals(137)
      expect(dismissed).equals(0)
    })

    it('reports an exhausted band honestly, keeps safe dismissal, and reveals controls after an ordinary keyboard change', async function () {
      const callbacks = keyboardListeners()
      let back: (() => boolean | undefined) | undefined
      let close = 0
      Keyboard.metrics = () => ({
        screenX: 0,
        screenY: 0,
        width: 390,
        height: 844
      })
      BackHandler.addEventListener = (_event, accept) => {
        back = () => accept({ type: 'hardwareBackPress', timeStamp: 1 })
        return { remove: () => {} }
      }
      const node = await render(
        <MessageActionOverlay
          {...overlay({
            onClose: () => {
              close += 1
            }
          })}
        />
      )
      expect(
        getComputedStyle(
          node.querySelector<HTMLElement>(
            '[data-testid="chat-message-spotlight-controls"]'
          )!
        ).height
      ).equals('0px')
      expect(
        node.querySelector('[data-testid="chat-message-spotlight-panel"]')
      ).equals(null)
      expect(node.querySelector('[aria-label="Allowed action"]')).equals(null)
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true
        })
      )
      await press('Cancel')
      expect(back?.()).equals(true)
      expect(close).equals(3)
      await act(async () => {
        ;[...callbacks.values()][0](keyboardEvent(96))
      })
      expect(
        getComputedStyle(
          node.querySelector<HTMLElement>(
            '[data-testid="chat-message-spotlight-panel"]'
          )!
        ).height
      ).equals('96px')
      expect(node.querySelector('[aria-label="Allowed action"]')).not.equals(
        null
      )
    })
    it('sends the end value to its views again once the native entrance ends, not after an interrupted one', async function () {
      for (const finished of [true, false]) {
        await render(
          <ChatOverlayHost>
            <MessageActionOverlay {...overlay()} />
          </ChatOverlayHost>
        )
        const animation = animations.at(-1)!
        expect(animation.config.toValue).equals(1)
        const sent: number[] = []
        const setValue = animation.value.setValue.bind(animation.value)
        animation.value.setValue = (value: number) => {
          sent.push(value)
          setValue(value)
        }
        await act(async () => {
          animation.end?.({ finished })
          await Promise.resolve()
        })
        expect(sent, String(finished)).deep.equals(finished ? [1] : [])
        await act(async () => {
          root?.unmount()
        })
        root = undefined
      }
    })
    it('keeps every faded layer on one frame however its part is measured', async function () {
      // iOS re-applies a view's own opacity when its frame changes and then
      // ignores the native driver's value; a part re-measured after the fade
      // stayed invisible. Only constant-frame layers may carry the fade.
      for (const variant of ['short', 'tall', 'compact'] as const) {
        const windowHeight = variant === 'compact' ? 120 : 844
        Object.defineProperty(document.documentElement, 'clientHeight', {
          configurable: true,
          value: windowHeight
        })
        window.dispatchEvent(new window.Event('resize'))
        const node = await render(
          <ChatOverlayHost>
            <MessageActionOverlay
              {...overlay(
                variant === 'tall'
                  ? {
                      source: {
                        ...source,
                        bounds: { ...source.bounds, height: 900 }
                      }
                    }
                  : {}
              )}
            />
          </ChatOverlayHost>
        )
        await act(async () => {
          animations.at(-1)!.value.setValue(0.5)
        })
        const parts = (): HTMLElement[] =>
          [
            'chat-message-spotlight-reactions',
            'chat-message-spotlight-preview',
            'chat-message-spotlight-panel'
          ].flatMap(id => [
            ...node.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)
          ])
        const frames = (): string[] =>
          parts().map(part => {
            const layer = layerOf(part)
            expect(getComputedStyle(part).opacity, variant).equals('1')
            expect(getComputedStyle(layer).opacity, variant).equals('0.5')
            expect(layer.style.position, variant).equals('absolute')
            return [
              layer.style.top,
              layer.style.left,
              layer.style.width,
              layer.style.height
            ].join(' ')
          })
        const before = frames()
        expect(before.length, variant).equals(variant === 'compact' ? 1 : 3)
        for (const frame of before)
          expect(frame, variant).match(
            new RegExp(`^0px 0px \\d+px ${windowHeight}px$`)
          )
        // Every part reports its measured content, as a device does late.
        const heights: Record<string, string> = {}
        for (const part of parts())
          heights[part.dataset.testid!] = part.style.height
        await act(async () => {
          for (const element of node.querySelectorAll<HTMLElement>('*')) {
            const handler = (
              element as HTMLElement & {
                __reactLayoutHandler?: (event: unknown) => void
              }
            ).__reactLayoutHandler
            if (
              element.closest(
                '[data-testid="chat-message-spotlight-controls"]'
              ) != null
            )
              handler?.({
                nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 37 } }
              })
          }
          await Promise.resolve()
        })
        expect(
          parts().some(
            part => part.style.height !== heights[part.dataset.testid!]
          ),
          variant + ' measured parts resized'
        ).equals(variant !== 'compact')
        expect(frames(), variant).deep.equals(before)
        await act(async () => {
          root?.unmount()
        })
        root = undefined
      }
    })
    it('keeps the selected preview on the coordinated fade when motion resolves after the entrance begins', async function () {
      let resolveMotion: ((enabled: boolean) => void) | undefined
      AccessibilityInfo.isReduceMotionEnabled = async (): Promise<boolean> =>
        await new Promise<boolean>(resolve => {
          resolveMotion = resolve
        })
      let closed = 0
      const props = overlay({
        onClosed: () => {
          closed += 1
        }
      })
      const scene = (closing = false): React.ReactElement => (
        <ChatOverlayHost>
          <div data-testid="history" style={{ overflow: 'scroll' }}>
            History
          </div>
          <MessageActionOverlay {...props} closing={closing} />
        </ChatOverlayHost>
      )
      const node = await render(scene())
      const history = node.querySelector<HTMLElement>(
        '[data-testid="history"]'
      )!
      history.scrollTop = 137
      const preview = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-preview"]'
      )!
      const panel = node.querySelector<HTMLElement>(
        '[data-testid="chat-message-spotlight-panel"]'
      )!
      expect(animations.at(-1)!.config).includes({
        duration: 80,
        toValue: 1,
        useNativeDriver: true
      })
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0')
      expect(moved(preview)).equals(false)
      await act(async () => {
        resolveMotion!(false)
        await Promise.resolve()
      })
      expect(animations.at(-1)!.config).includes({
        duration: 200,
        toValue: 1,
        useNativeDriver: true
      })
      expect(moved(preview)).equals(true)
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0')
      await act(async () => {
        animations.at(-1)!.value.setValue(0.5)
      })
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0.5')
      expect(getComputedStyle(layerOf(panel)).opacity).equals('0.5')
      await finish()
      expect(getComputedStyle(layerOf(preview)).opacity).equals('1')
      expect(getComputedStyle(layerOf(panel)).opacity).equals('1')
      await render(scene(true))
      expect(animations.at(-1)!.config).includes({
        duration: 200,
        toValue: 0,
        useNativeDriver: true
      })
      await act(async () => {
        animations.at(-1)!.value.setValue(0.5)
      })
      // Halfway back, the preview is on its way to the source.
      expect(moved(preview)).equals(true)
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0.5')
      expect(getComputedStyle(layerOf(panel)).opacity).equals('0.5')
      expect(closed).equals(0)
      await finish()
      expect(getComputedStyle(layerOf(preview)).opacity).equals('0')
      expect(getComputedStyle(layerOf(panel)).opacity).equals('0')
      expect(closed).equals(1)
      expect(history.scrollTop).equals(137)
    })
    it('coordinates native-driver entrance and reverse exit without changing the background position', async function () {
      let closed = 0
      const node = await render(
        <ChatOverlayHost>
          <div data-testid="history" style={{ overflow: 'scroll' }}>
            History
          </div>
          <MessageActionOverlay
            {...overlay({
              onClosed: () => {
                closed += 1
              }
            })}
          />
        </ChatOverlayHost>
      )
      const history = node.querySelector('[data-testid="history"]')!
      history.scrollTop = 137
      expect(history.closest('[aria-hidden="true"]')).not.equals(null)
      expect(animations.at(-1)!.config).includes({
        toValue: 1,
        duration: 200,
        useNativeDriver: true
      })
      await finish()
      await render(
        <ChatOverlayHost>
          <div data-testid="history" style={{ overflow: 'scroll' }}>
            History
          </div>
          <MessageActionOverlay
            {...overlay({
              closing: true,
              focusHandoff: true,
              onClosed: () => {
                closed += 1
              }
            })}
          />
        </ChatOverlayHost>
      )
      expect(history.closest('[aria-hidden="true"]')).equals(null)
      expect(animations.at(-1)!.config.toValue).equals(0)
      expect(closed).equals(0)
      await finish()
      expect(closed).equals(1)
      expect(history.scrollTop).equals(137)
    })

    it('uses a short fade for reduced motion and fades safely when the original is gone', async function () {
      reduced = true
      let node = await render(<MessageActionOverlay {...overlay()} />)
      expect(animations.at(-1)!.config.duration).equals(80)
      expect(
        node.querySelector<HTMLElement>(
          '[data-testid="chat-message-spotlight-preview"]'
        )!.style.transform
      ).equals('')
      reduced = false
      const missing: MessageSource = {
        bounds,
        measure: accept => {
          accept(undefined)
          return () => {}
        }
      }
      node = await render(
        <MessageActionOverlay
          {...overlay({ closing: true, source: missing })}
        />
      )
      expect(
        node.querySelector<HTMLElement>(
          '[data-testid="chat-message-spotlight-preview"]'
        )!.style.transform
      ).equals('')
    })

    it('cancels an in-flight entrance, source callback and final callback after unmount', async function () {
      let closed = 0
      let cancelled = 0
      let deliver: ((value: ChatBounds | undefined) => void) | undefined
      const delayed: MessageSource = {
        bounds,
        measure: accept => {
          deliver = accept
          return () => {
            cancelled += 1
          }
        }
      }
      await render(
        <MessageActionOverlay
          {...overlay({
            source: delayed,
            closing: true,
            onClosed: () => {
              closed += 1
            }
          })}
        />
      )
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      deliver?.(bounds)
      expect(cancelled).equals(1)
      expect(closed).equals(0)
    })

    it('handles Escape, outside tap and native Back during entrance and keeps Back owned through exit', async function () {
      let close = 0
      let back: (() => boolean | undefined) | undefined
      let removed = 0
      BackHandler.addEventListener = (_event, accept) => {
        back = () => accept({ type: 'hardwareBackPress', timeStamp: 1 })
        return {
          remove: () => {
            removed += 1
          }
        }
      }
      await render(
        <MessageActionOverlay
          {...overlay({
            onClose: () => {
              close += 1
            }
          })}
        />
      )
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true
        })
      )
      await press('Cancel')
      expect(back?.()).equals(true)
      expect(close).equals(3)
      await render(<MessageActionOverlay {...overlay({ closing: true })} />)
      expect(removed).equals(0)
      expect(back?.()).equals(true)
      expect(close).equals(3)
      expect(
        host!
          .querySelector('[data-testid="chat-message-spotlight"]')!
          .getAttribute('aria-hidden')
      ).not.equals('true')
    })

    it('observes an already-open keyboard, follows keyboard geometry changes and removes ownership', async function () {
      const callbacks = keyboardListeners()
      Keyboard.metrics = () => ({
        screenX: 0,
        screenY: 420,
        width: 390,
        height: 424
      })
      await render(<MessageActionOverlay {...overlay()} />)
      expect(callbacks.size).equals(2)
      await act(async () => {
        ;[...callbacks.values()][0](keyboardEvent(360))
      })
      await act(async () => {
        ;[...callbacks.values()][1](keyboardEvent(844))
      })
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      expect(callbacks.size).equals(0)
    })
  })

  describe('chat message action ownership', function () {
    for (const platform of ['web', 'ios', 'android'] as const)
      it(`refuses touches beneath the ${platform} host modal without re-parenting or disabling a focused composer`, async function () {
        Object.defineProperty(Platform, 'OS', {
          configurable: true,
          value: platform
        })
        const node = await render(
          <ChatOverlayHost>
            <input aria-label="Native composer" />
            <MessageMenu {...menu({})} />
          </ChatOverlayHost>
        )
        const content = node
          .querySelector('[aria-label="Native composer"]')!
          .closest<HTMLElement>('[aria-hidden="true"]')!
        expect(content).not.equals(null)
        expect(getComputedStyle(content).pointerEvents).equals(
          platform === 'web' ? 'none' : 'auto'
        )
        expect(
          getComputedStyle(
            node.querySelector('[aria-label="Native composer"]')!
          ).pointerEvents
        ).equals('none')
        expect(
          hostViewProps(content).collapsable,
          'A flattened chat view would be re-parented when it turns modal'
        ).equals(false)
      })

    it('releases the native host modal before replying once after exit', async function () {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'ios'
      })
      const calls: Array<{ hidden: boolean }> = []
      let closed = 0
      function Scene(): React.ReactElement {
        const [open, setOpen] = useState(true)
        return (
          <ChatOverlayHost>
            <input aria-label="Native composer" />
            {open && (
              <MessageMenu
                {...menu({
                  onReply: () => {
                    const composer = host!.querySelector<HTMLInputElement>(
                      '[aria-label="Native composer"]'
                    )!
                    const hidden =
                      composer.closest('[aria-hidden="true"]') != null
                    calls.push({ hidden })
                    if (!hidden) composer.focus()
                  },
                  onClose: () => {
                    closed += 1
                    setOpen(false)
                  }
                })}
              />
            )}
          </ChatOverlayHost>
        )
      }
      const node = await render(<Scene />)
      const composer = node.querySelector<HTMLInputElement>(
        '[aria-label="Native composer"]'
      )!
      expect(composer.closest('[aria-hidden="true"]')).not.equals(null)
      const reply = button('Reply')
      await act(async () => {
        reply.click()
        reply.click()
      })
      expect(calls, 'Native focus must wait for the host handoff').deep.equals(
        []
      )
      expect(composer.closest('[aria-hidden="true"]')).equals(null)
      expect(closed).equals(0)
      await finish()
      expect(calls).deep.equals([{ hidden: false }])
      expect(closed).equals(1)
      expect(document.activeElement).equals(composer)
      expect(
        node.querySelector('[data-testid="chat-message-spotlight"]')
      ).equals(null)
    })

    for (const platform of ['ios', 'android'] as const) {
      for (const change of [
        'permission',
        'target',
        'status',
        'unmount'
      ] as const)
        it(`cancels deferred ${platform} Reply after ${change}`, async function () {
          Object.defineProperty(Platform, 'OS', {
            configurable: true,
            value: platform
          })
          let replies = 0
          function Scene({
            changed = false
          }: {
            changed?: boolean
          }): React.ReactElement {
            const [open, setOpen] = useState(true)
            return (
              <ChatOverlayHost>
                <input aria-label="Native composer" />
                {open && !(changed && change === 'unmount') && (
                  <MessageMenu
                    {...menu({
                      message: message({
                        id:
                          changed && change === 'target'
                            ? 'msg_replaced'
                            : 'msg_1',
                        status:
                          changed && change === 'status' ? 'removed' : 'ok'
                      }),
                      actions:
                        changed && change === 'permission'
                          ? ['copy']
                          : ['reply', 'copy'],
                      onReply: () => {
                        replies += 1
                      },
                      onClose: () => {
                        setOpen(false)
                      }
                    })}
                  />
                )}
              </ChatOverlayHost>
            )
          }
          await render(<Scene />)
          await press('Reply')
          expect(replies).equals(0)
          await render(<Scene changed />)
          await finish()
          expect(replies).equals(0)
          expect(
            host!.querySelector('[data-testid="chat-message-spotlight"]')
          ).equals(null)
        })

      it(`uses the latest ${platform} Reply callback once after a successful handoff`, async function () {
        Object.defineProperty(Platform, 'OS', {
          configurable: true,
          value: platform
        })
        const calls: string[] = []
        function Scene({ revision }: { revision: string }): React.ReactElement {
          const [open, setOpen] = useState(true)
          return (
            <ChatOverlayHost>
              <input aria-label="Native composer" />
              {open && (
                <MessageMenu
                  {...menu({
                    onReply: () => {
                      calls.push(revision)
                    },
                    onClose: () => {
                      setOpen(false)
                    }
                  })}
                />
              )}
            </ChatOverlayHost>
          )
        }
        await render(<Scene revision="before" />)
        const reply = button('Reply')
        await press('Reply')
        await render(<Scene revision="current" />)
        await act(async () => {
          reply.click()
        })
        expect(calls).deep.equals([])
        await finish()
        expect(calls).deep.equals(['current'])
      })
    }

    it('keeps the exact filtered mobile set and focuses Reply synchronously through exit without restoring the trigger', async function () {
      let closed = 0
      function Scene(): React.ReactElement {
        const [open, setOpen] = useState(true)
        return (
          <ChatOverlayHost>
            <input aria-label="Composer" />
            <button aria-label="Trigger">Trigger</button>
            {open && (
              <MessageMenu
                {...menu({
                  onReply: () => {
                    document
                      .querySelector<HTMLElement>('[aria-label="Composer"]')!
                      .focus()
                  },
                  onClose: () => {
                    closed += 1
                    setOpen(false)
                  }
                })}
              />
            )}
          </ChatOverlayHost>
        )
      }
      const node = await render(<Scene />)
      for (const excluded of [
        'Forward',
        'Select',
        'Speak',
        'Info',
        'Edit',
        'Report'
      ])
        expect(
          [...node.querySelectorAll('[role="button"],button')].some(
            value => value.textContent === excluded
          )
        ).equals(false)
      const reply = button('Reply')
      await act(async () => {
        reply.click()
        expect(document.activeElement?.getAttribute('aria-label')).equals(
          'Composer'
        )
      })
      expect(closed).equals(0)
      expect(
        node
          .querySelector('[aria-label="Composer"]')!
          .closest('[aria-hidden="true"]')
      ).equals(null)
      await finish()
      expect(closed).equals(1)
      expect(document.activeElement?.getAttribute('aria-label')).equals(
        'Composer'
      )
    })

    describe('desktop message menu opener ownership', function () {
      async function mountMenu(): Promise<{
        composer: HTMLTextAreaElement
        trigger: HTMLElement
        history: HTMLElement
        removeSource: () => void
      }> {
        Object.defineProperty(globalThis, 'matchMedia', {
          configurable: true,
          value: () => ({ matches: true })
        })
        let removeSource = (): void => {}
        function Scene(): React.ReactElement {
          const [anchor, setAnchor] = useState<unknown>(undefined)
          const [showSource, setShowSource] = useState(true)
          removeSource = () => {
            setShowSource(false)
          }
          return (
            <ChatOverlayHost>
              <textarea aria-label="Composer" defaultValue="Unsent draft" />
              <div aria-label="Reader">
                {showSource && (
                  <MessageBubble
                    {...bubble({
                      actions: ['reply', 'copy'],
                      onLongPress: (_message, target) => {
                        setAnchor(target)
                      }
                    })}
                  />
                )}
              </div>
              {anchor != null && (
                <MessageMenu
                  {...menu({
                    desktop: true,
                    anchor,
                    actions: ['reply', 'copy'],
                    onReply: () => {
                      document
                        .querySelector<HTMLElement>('[aria-label="Composer"]')!
                        .focus()
                    },
                    onClose: () => {
                      setAnchor(undefined)
                    }
                  })}
                />
              )}
            </ChatOverlayHost>
          )
        }
        const node = await render(<Scene />)
        const composer = node.querySelector<HTMLTextAreaElement>(
          '[aria-label="Composer"]'
        )!
        const history = node.querySelector<HTMLElement>(
          '[aria-label="Reader"]'
        )!
        history.scrollTop = 200
        return {
          composer,
          trigger: button('More message actions'),
          history,
          removeSource: () => {
            removeSource()
          }
        }
      }
      async function escapeMenu(): Promise<void> {
        await act(async () => {
          document.dispatchEvent(
            new window.KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true
            })
          )
          await new Promise(resolve => setTimeout(resolve, 25))
        })
      }
      for (const focusedTrigger of [false, true]) {
        it(`returns Escape to the actual More opener when trigger focus is ${String(focusedTrigger)}`, async function () {
          const { composer, trigger, history } = await mountMenu()
          await act(async () => {
            composer.focus()
            if (focusedTrigger) trigger.focus()
          })
          await press('More message actions')
          expect(trigger.closest('[aria-hidden="true"]')).not.equals(null)
          expect(document.activeElement).equals(button('Copy text'))
          await escapeMenu()
          expect(
            host!.querySelector('[aria-label="Message from Trea Turner"]')
          ).equals(null)
          expect(trigger.closest('[aria-hidden="true"]')).equals(null)
          expect(
            document.activeElement,
            'The actual More opener owns dismissal focus'
          ).equals(trigger)
          expect(composer.value).equals('Unsent draft')
          expect(history.scrollTop).equals(200)
        })
      }
      it('preserves an explicit later focus handoff to the composer', async function () {
        const { composer, trigger } = await mountMenu()
        await act(async () => {
          composer.focus()
        })
        await press('More message actions')
        await act(async () => {
          composer.focus()
        })
        await escapeMenu()
        expect(document.activeElement).equals(composer)
        expect(trigger.closest('[aria-hidden="true"]')).equals(null)
        expect(
          host!.querySelector('[aria-label="Message from Trea Turner"]')
        ).equals(null)
      })
      it('retires a disconnected More opener without focusing it', async function () {
        const { composer, trigger, removeSource } = await mountMenu()
        await act(async () => {
          composer.focus()
        })
        await press('More message actions')
        let focused = 0
        trigger.addEventListener('focus', () => {
          focused += 1
        })
        await act(async () => {
          removeSource()
          await new Promise(resolve => setTimeout(resolve, 25))
        })
        expect(trigger.isConnected).equals(false)
        expect(focused).equals(0)
        expect(
          host!.querySelector('[aria-label="Message from Trea Turner"]')
        ).equals(null)
      })
    })

    it('filters desktop More and revalidates permission changes while a copy promise is pending', async function () {
      let closed = 0
      let complete: (() => void) | undefined
      const anchor = document.createElement('button')
      document.body.append(anchor)
      const props = menu({
        desktop: true,
        anchor,
        actions: ['copy', 'unpin'],
        onCopy: async () => {
          await new Promise<void>(resolve => {
            complete = resolve
          })
        },
        onClose: () => {
          closed += 1
        }
      })
      await render(<MessageMenu {...props} />)
      expect(button('Copy text')).not.equals(undefined)
      expect(button('Unpin')).not.equals(undefined)
      expect(host!.querySelector('[aria-label="Reply"]')).equals(null)
      expect(host!.querySelector('[aria-label^="React with"]')).equals(null)
      await press('Copy text')
      await render(<MessageMenu {...props} actions={[]} />)
      expect(closed).equals(1)
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      complete?.()
      await Promise.resolve()
      expect(closed).equals(1)
    })

    it('defers the emoji picker until exit, runs permitted reactions and pin changes once, and confirms deletes', async function () {
      const calls: string[] = []
      const props = menu({
        onMoreEmoji: () => calls.push('more'),
        onReact: emoji => calls.push(emoji),
        onPin: value => calls.push(`pin:${String(value)}`),
        onDeleteForEveryone: () => calls.push('moderate')
      })
      let instance = 0
      const fresh = async (): Promise<void> => {
        await render(<MessageMenu key={++instance} {...props} />)
      }
      await fresh()
      await press('More emoji')
      expect(calls).deep.equals([])
      await finish()
      expect(calls).deep.equals(['more'])
      await fresh()
      await press('React with 👍')
      await press('React with 👍')
      expect(calls).deep.equals(['more', '👍'])
      await fresh()
      await press('Pin')
      expect(calls.at(-1)).equals('pin:true')
      await fresh()
      await press('Delete')
      expect(calls).not.contains('moderate')
      expect(document.activeElement?.textContent).contains('Cancel')
      await press('Delete')
      expect(calls.at(-1)).equals('moderate')
    })
  })

  describe('chat reduced transparency settings', function () {
    it('uses the readable shared fallback when the browser has no transparency preference API', function () {
      Reflect.deleteProperty(window, 'matchMedia')
      const values: boolean[] = []
      watchReducedTransparency(value => values.push(value))()
      expect(values).deep.equals([false])
    })
    it('observes browser changes and detaches its listener', function () {
      let changed: (() => void) | undefined
      let removed = 0
      const query = {
        matches: true,
        addEventListener: (_event: string, accept: () => void) => {
          changed = accept
        },
        removeEventListener: () => {
          removed += 1
        }
      }
      window.matchMedia = (() => query) as unknown as typeof window.matchMedia
      const values: boolean[] = []
      const stop = watchReducedTransparency(value => values.push(value))
      query.matches = false
      changed?.()
      stop()
      expect(values).deep.equals([true, false])
      expect(removed).equals(1)
    })

    it('lets live native settings win a delayed initial query and ignores completion after teardown', async function () {
      let initial: ((value: boolean) => void) | undefined
      let changed: ((value: boolean) => void) | undefined
      let removed = 0
      AccessibilityInfo.isReduceTransparencyEnabled = async () =>
        await new Promise<boolean>(resolve => {
          initial = resolve
        })
      Object.defineProperty(AccessibilityInfo, 'addEventListener', {
        configurable: true,
        writable: true,
        value: (event: string, accept: (value: boolean) => void) => {
          expect(event).equals('reduceTransparencyChanged')
          changed = accept
          return {
            remove: () => {
              removed += 1
            }
          }
        }
      })
      const values: boolean[] = []
      const stop = watchNativeTransparency(value => values.push(value))
      changed?.(true)
      initial?.(false)
      await Promise.resolve()
      stop()
      changed?.(false)
      expect(values).deep.equals([true])
      expect(removed).equals(1)
      const stopSecond = watchNativeTransparency(value => values.push(value))
      stopSecond()
      initial?.(false)
      await Promise.resolve()
      expect(values).deep.equals([true])
    })
  })
})
