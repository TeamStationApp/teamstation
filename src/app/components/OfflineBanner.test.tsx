import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Animated, View } from 'react-native'

import { ScopedThemeProvider, type Theme } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import {
  OFFLINE_BANNER_BACKGROUND,
  OFFLINE_BANNER_TEXT,
  OfflineBanner,
  type OfflineBannerProps,
  useOfflineBannerHeight
} from './OfflineBanner'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function draw(
  theme: Theme,
  props: OfflineBannerProps
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ScopedThemeProvider theme={theme}>
        <OfflineBanner {...props} />
      </ScopedThemeProvider>
    )
  })
  return host
}

/** `#RRGGBB` as the browser reports a computed colour. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

/** Whether a line is drawn underlined, however the web writes it. */
const underlined = (node: HTMLElement): boolean => {
  const style = getComputedStyle(node)
  return `${style.textDecorationLine} ${style.textDecoration}`.includes(
    'underline'
  )
}

const byTestId = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`)

describe('the offline banner', () => {
  it('fixes the fill and the text colour', () => {
    expect(OFFLINE_BANNER_BACKGROUND).equals('#6B3E00')
    expect(OFFLINE_BANNER_TEXT).equals('#ffffff')
  })

  for (const [name, theme] of [
    ['ballpark', tsBallpark],
    ['dark', tsDark]
  ] as const) {
    it(`is white on #6B3E00 in the ${name} theme, a refusal and a line that opens the held list included`, async () => {
      const host = await draw(theme, {
        text: '1 edit not sent',
        refusal: 'Creating needs a connection',
        onOpenHeld: () => {}
      })
      const banner = byTestId(host, 'offlineBanner')!
      expect(getComputedStyle(banner).backgroundColor).equals(rgb('#6B3E00'))
      const lines = [
        byTestId(host, 'offlineBannerText')!,
        byTestId(host, 'offlineCreateMessage')!
      ]
      for (const line of lines)
        expect(getComputedStyle(line).color, line.textContent!).equals(
          rgb('#ffffff')
        )
    })
  }

  it('draws nothing with nothing to say', async () => {
    const host = await draw(tsBallpark, {})
    expect(byTestId(host, 'offlineBanner')).equals(null)
  })

  it('takes the place the shell gives it, and reports its height', async () => {
    const heights: number[] = []
    const host = await draw(tsBallpark, {
      text: 'Offline',
      style: { position: 'absolute', bottom: 34 },
      onLayout: height => heights.push(height)
    })
    const banner = byTestId(host, 'offlineBanner')!
    const content = byTestId(host, 'offlineBannerContent')! as HTMLElement & {
      __reactLayoutHandler?: (event: object) => void
    }
    expect(getComputedStyle(banner).position).equals('absolute')
    expect(getComputedStyle(banner).bottom).equals('34px')
    await act(async () => {
      content.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 40 } }
      })
    })
    expect(heights).deep.equals([40])
  })

  it('reports the painted height to the shell and reverses an exit from its current frame', async () => {
    const timing = Object.getOwnPropertyDescriptor(Animated, 'timing')!
    let advance!: (height: number, finished?: boolean) => void
    const targets: number[] = []
    const observed: number[] = []
    const animate: typeof Animated.timing = (value, config) => ({
      start: end => {
        targets.push(Number(config.toValue))
        advance = (frame, finished) => {
          ;(value as Animated.Value).setValue(frame)
          if (finished === true) end?.({ finished: true })
        }
      },
      stop: () => {},
      reset: () => {}
    })
    Object.defineProperty(Animated, 'timing', { ...timing, value: animate })
    const report = (height: number): void => {
      observed.push(height)
    }
    try {
      const host = await draw(tsBallpark, {
        text: 'Offline',
        onPresentedHeight: report
      })
      const layout = byTestId(host, 'offlineBannerContent')! as HTMLElement & {
        __reactLayoutHandler: (event: object) => void
      }
      const show = async (text?: string): Promise<void> => {
        await act(async () => {
          root!.render(
            <ScopedThemeProvider theme={tsBallpark}>
              <OfflineBanner text={text} onPresentedHeight={report} />
            </ScopedThemeProvider>
          )
        })
      }
      await act(async () => {
        layout.__reactLayoutHandler({
          nativeEvent: { layout: { width: 390, height: 34 } }
        })
      })
      await act(async () => {
        advance(12)
        advance(34, true)
      })
      await show()
      await act(async () => {
        advance(18)
      })
      expect(
        byTestId(host, 'offlineBanner')!.getAttribute('aria-hidden')
      ).equals('true')
      expect(byTestId(host, 'offlineBannerText')!.textContent).equals('Offline')
      await show('Sending an edit')
      expect(observed.at(-1)).equals(18)
      expect(byTestId(host, 'offlineBannerText')!.textContent).equals(
        'Sending an edit'
      )
      await act(async () => {
        advance(34, true)
      })
      await show()
      await act(async () => {
        advance(9)
        advance(0, true)
      })
      expect(byTestId(host, 'offlineBanner')).equals(null)
      expect(targets).deep.equals([34, 0, 34, 0])
      expect(observed).deep.equals([0, 12, 34, 18, 34, 9, 0])
    } finally {
      Object.defineProperty(Animated, 'timing', timing)
    }
  })

  for (const reduced of [false, true]) {
    it(`commits web clearance at the endpoints, preserving moving docks on reversal (reduced motion ${reduced})`, async () => {
      const animate = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'animate'
      )
      const preference = Object.getOwnPropertyDescriptor(
        AccessibilityInfo,
        'isReduceMotionEnabled'
      )!
      const calls: Array<{
        node: HTMLElement
        frames: Keyframe[]
        duration: number
        job: { onfinish?: () => void }
      }> = []
      const offsets = new WeakMap<HTMLElement, number>()
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value(
          this: HTMLElement,
          frames: Keyframe[],
          options: KeyframeAnimationOptions
        ) {
          const job: { cancel: () => void; onfinish?: () => void } = {
            cancel: () => {
              offsets.delete(this)
            }
          }
          calls.push({
            node: this,
            frames,
            duration: Number(options.duration),
            job
          })
          return job
        }
      })
      Object.defineProperty(AccessibilityInfo, 'isReduceMotionEnabled', {
        configurable: true,
        value: async () => reduced
      })
      const heights: number[] = []
      function Shell({ label }: { label?: string }): React.ReactElement {
        const { shell, height, report } = useOfflineBannerHeight()
        React.useLayoutEffect(() => {
          heights.push(height)
        }, [height])
        return (
          <View ref={shell}>
            <View testID="reader" />
            <View
              testID="dock"
              dataSet={{ offlineBannerDock: 'true' }}
              style={{ position: 'absolute', bottom: height + 12 }}
            />
            <View
              testID="fixed-dock"
              dataSet={{ offlineBannerDock: 'true' }}
              style={{ position: 'absolute', bottom: 80 }}
            />
            <OfflineBanner text={label} onPresentedHeight={report} />
          </View>
        )
      }
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      const show = async (label?: string): Promise<void> => {
        await act(async () => {
          root!.render(
            <ScopedThemeProvider theme={tsBallpark}>
              <Shell label={label} />
            </ScopedThemeProvider>
          )
        })
      }
      try {
        await show('Offline')
        const dock = byTestId(host, 'dock')!
        const strip = byTestId(host, 'offlineBanner')!
        const content = byTestId(
          host,
          'offlineBannerContent'
        )! as HTMLElement & {
          __reactLayoutHandler: (event: object) => void
        }
        dock.getBoundingClientRect = () =>
          new window.DOMRect(
            0,
            (offsets.get(dock) ?? 0) - parseFloat(dock.style.bottom),
            100,
            30
          )
        const measure = async (height: number): Promise<void> => {
          await act(async () => {
            content.__reactLayoutHandler({
              nativeEvent: { layout: { width: 390, height } }
            })
          })
        }
        await measure(34)
        expect(heights).deep.equals([0, 34])
        const first = calls.find(call => call.node === dock)!
        expect(first.frames.map(frame => frame.translate)).deep.equals([
          '0 34px',
          '0 0px'
        ])
        expect(first.duration).equals(reduced ? 90 : 160)
        offsets.set(dock, 12)
        await show()
        const closing = calls.filter(call => call.node === dock).at(-1)!
        expect(closing.frames.map(frame => frame.translate)).deep.equals([
          '0 -22px',
          '0 0px'
        ])
        expect(strip.getAttribute('aria-hidden')).equals('true')
        expect(byTestId(host, 'offlineBannerText')?.textContent).equals(
          'Offline'
        )
        const closeAnimation = calls
          .filter(call => call.node === strip)
          .at(-1)!.job
        offsets.set(dock, -6)
        await show('Sending')
        expect(
          calls.filter(call => call.node === dock).at(-1)!.frames[0].translate
        ).equals('0 28px')
        closeAnimation.onfinish?.()
        expect(byTestId(host, 'offlineBannerText')?.textContent).equals(
          'Sending'
        )
        await measure(48)
        expect(heights).deep.equals([0, 34, 0, 34, 48])
        expect(
          calls.some(
            call =>
              call.node === byTestId(host, 'reader') ||
              call.node === byTestId(host, 'fixed-dock')
          )
        ).equals(false)
        await show()
        const last = calls.filter(call => call.node === strip).at(-1)!.job
        await act(async () => {
          last.onfinish?.()
        })
        expect(byTestId(host, 'offlineBanner')).equals(null)
        expect(heights).deep.equals([0, 34, 0, 34, 48, 0])
      } finally {
        if (animate != null)
          Object.defineProperty(HTMLElement.prototype, 'animate', animate)
        else delete (HTMLElement.prototype as Partial<HTMLElement>).animate
        Object.defineProperty(
          AccessibilityInfo,
          'isReduceMotionEnabled',
          preference
        )
      }
    })
  }

  it('opens the held list from its line, a button labelled for it', async () => {
    let opened = 0
    const host = await draw(tsBallpark, {
      text: '2 edits not sent',
      onOpenHeld: () => opened++
    })
    const button = byTestId(host, 'offlineBannerButton')!
    expect(button.getAttribute('role')).equals('button')
    expect(button.getAttribute('aria-label')).equals('Edits not sent')
    expect(underlined(byTestId(host, 'offlineBannerText')!)).equals(true)
    await act(async () => {
      button.click()
    })
    expect(opened).equals(1)
  })

  it('keeps the line plain text with nothing held', async () => {
    const host = await draw(tsBallpark, { text: 'Sending 1 edit…' })
    expect(byTestId(host, 'offlineBannerButton')).equals(null)
    expect(byTestId(host, 'offlineBannerText')!.textContent).equals(
      'Sending 1 edit…'
    )
    expect(underlined(byTestId(host, 'offlineBannerText')!)).equals(false)
  })
})
