import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Keyboard,
  type KeyboardEvent as NativeKeyboardEvent
} from 'react-native'

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
    members: [member(2, 'Trea Turner')],
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
      node = await render(
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
      expect(preview.style.transform).equals('')
      expect(getComputedStyle(preview).opacity).equals('0')
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
      expect(getComputedStyle(preview).opacity).equals('1')
      expect(history.scrollTop).equals(137)
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
      expect(preview.style.transform).not.equals('')
      await finish()
      await render(<MessageActionOverlay {...props} closing />)
      expect(preview.style.transform).equals('')
      expect(getComputedStyle(preview).opacity).equals('1')
      await finish()
      expect(getComputedStyle(preview).opacity).equals('0')
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
