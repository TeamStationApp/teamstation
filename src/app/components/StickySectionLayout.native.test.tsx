import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { HeaderSlotProvider } from './headerSlot'
import { usePinned } from './pinnedGlass'
import { SceneTopProvider } from './sceneTop'
import { StickySectionLayout } from './StickySectionLayout.native'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
describe('the native season layout', () => {
  it('places its hero before its raised section strip and clears the overlay header', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider headerHeight={72} onHandoff={() => undefined}>
            <StickySectionLayout
              hero={
                <View>
                  <Text>Season identity</Text>
                </View>
              }
              sections={<Text>Season sections</Text>}
              onScroll={() => undefined}
            >
              <Text>Season games</Text>
            </StickySectionLayout>
          </HeaderSlotProvider>
        </ThemeProvider>
      )
    })
    const content = host.textContent!
    expect(content.indexOf('Season identity')).lessThan(
      content.indexOf('Season sections')
    )
    expect(content.indexOf('Season sections')).lessThan(
      content.indexOf('Season games')
    )
    const sticky = host.querySelector<HTMLElement>(
      '[data-testid="sticky-season-sections"]'
    )!
    expect(getComputedStyle(sticky).zIndex).equals('3')
    expect(sticky.style.transform).contains('translateY(0px)')
    expect(
      [...host.querySelectorAll<HTMLElement>('div')].some(
        node => node.style.paddingTop === '72px'
      )
    ).equals(true)
  })

  describe('the native season layout: the glass its sections carry', () => {
    const HEADER = 72
    /** The section's top in the content, the header's padding included. */
    const SECTION_TOP = 400
    const PIN_AT = SECTION_TOP - HEADER
    const SECTION = 60
    let carried: boolean | undefined
    function Header(): null {
      carried = usePinned()
      return null
    }
    const draw = async (top: boolean, layout = true): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <HeaderSlotProvider
              headerHeight={HEADER}
              onHandoff={() => undefined}
            >
              <Header />
              {layout && (
                <SceneTopProvider value={top}>
                  <StickySectionLayout
                    hero={<Text>Season identity</Text>}
                    sections={<Text>Season sections</Text>}
                    onScroll={() => undefined}
                  >
                    <Text>Season games</Text>
                  </StickySectionLayout>
                </SceneTopProvider>
              )}
            </HeaderSlotProvider>
          </ThemeProvider>
        )
      })
    }
    const byId = (id: string): HTMLElement =>
      host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
    /** What the components above a node were given as `name`, nearest first. */
    const props = (node: Element, name: string): unknown[] => {
      const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'))!
      let fiber = (node as unknown as Record<string, any>)[key]
      const found: unknown[] = []
      while (fiber != null) {
        if (fiber.memoizedProps?.[name] != null)
          found.push(fiber.memoizedProps[name])
        fiber = fiber.return
      }
      return found
    }
    const frames = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
    }
    const scroll = async (y: number): Promise<void> => {
      const handler = props(byId('sticky-season-sections'), 'onScroll').find(
        h =>
          (h as { workletEventHandler?: unknown }).workletEventHandler != null
      ) as { workletEventHandler: { worklet: (event: unknown) => void } }
      await act(async () => {
        handler.workletEventHandler.worklet({
          eventName: 'onScroll',
          contentOffset: { x: 0, y },
          contentSize: { width: 390, height: 3000 },
          layoutMeasurement: { width: 390, height: 800 }
        })
      })
      await frames()
    }
    const layOut = async (y: number, height: number): Promise<void> => {
      const onLayout = props(byId('sticky-season-sections'), 'onLayout')[0] as (
        event: unknown
      ) => void
      await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y, width: 390, height } } })
      })
      await frames()
    }
    const pane = (): { top: string; height: string } => {
      const { top, height } = byId('sticky-section-glass').style
      return { top, height }
    }
    let host: HTMLDivElement
    const mount = async (top = true): Promise<void> => {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      await draw(top)
      // `sectionTop` is the header's padding plus the section's own y.
      await layOut(SECTION_TOP - HEADER, SECTION)
    }

    it('animates the pane from the scroll, pinning where the section meets the header', async () => {
      await mount()
      expect(pane()).deep.equals({
        top: `${-(HEADER + PIN_AT)}px`,
        height: `${HEADER}px`
      })
      await scroll(PIN_AT - SECTION)
      expect(pane()).deep.equals({
        top: `${-(HEADER + SECTION)}px`,
        height: `${HEADER}px`
      })
      await scroll(PIN_AT - SECTION / 2)
      expect(pane()).deep.equals({
        top: `${-(HEADER + SECTION / 2)}px`,
        height: `${HEADER + SECTION / 2}px`
      })
      await scroll(PIN_AT)
      expect(pane()).deep.equals({
        top: `${-HEADER}px`,
        height: `${HEADER + SECTION}px`
      })
      // A section that moves down moves the pin with it.
      await layOut(SECTION_TOP - HEADER + 100, SECTION)
      expect(pane()).deep.equals({
        top: `${-(HEADER + 100)}px`,
        height: `${HEADER}px`
      })
    })

    it('stays joined to the header near the end of short content', async () => {
      await mount()
      const resize = props(
        byId('sticky-season-sections'),
        'onContentSizeChange'
      )[0] as (width: number, height: number) => void
      // Content that ends just after the section: it stops following.
      await act(async () => {
        resize(390, SECTION_TOP + SECTION + 20)
      })
      await scroll(PIN_AT + 300)
      expect(byId('sticky-season-sections').style.transform).contains(
        'translateY(20px)'
      )
      expect(pane()).deep.equals({
        top: `${-HEADER}px`,
        height: `${HEADER + SECTION}px`
      })
    })

    it('reports once the pane grows, clears the section, and draws the glass and its line', async () => {
      await mount()
      const section = byId('sticky-season-sections')
      const opaque = section.style.backgroundColor
      expect(carried).equals(false)
      expect(byId('sticky-section-glass').children).length(0)
      await scroll(PIN_AT - SECTION)
      expect(carried).equals(false)
      await scroll(PIN_AT - SECTION + 2)
      expect(carried).equals(true)
      expect(section.style.backgroundColor).equals('rgba(0, 0, 0, 0)')
      const glass = byId('sticky-section-glass')
      expect(glass.children).length(2)
      expect(getComputedStyle(glass.children[1]).height).equals('1px')
      await scroll(PIN_AT + 100)
      expect(carried).equals(true)
      await scroll(10)
      expect(carried).equals(false)
      expect(section.style.backgroundColor).equals(opaque)
      expect(byId('sticky-section-glass').children).length(0)
    })

    it('reports nothing while its scene is not the top', async () => {
      await mount(false)
      await scroll(PIN_AT)
      expect(carried).equals(false)
      expect(pane().height).equals(`${HEADER + SECTION}px`)
    })

    it('lets go while covered and reports again after Back with no new scroll', async () => {
      await mount()
      await scroll(PIN_AT + 100)
      expect(carried).equals(true)
      // A push over it: progress stays 1, and no reaction runs.
      await draw(false)
      expect(carried).equals(false)
      // Back: still pinned, still no reaction; the kept progress reports.
      await draw(true)
      expect(carried).equals(true)
      // And it lets go as it unmounts.
      await draw(true, false)
      expect(carried).equals(false)
    })
  })
})
