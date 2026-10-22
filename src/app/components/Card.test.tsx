import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { ScopedThemeProvider, type Theme } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { Card, CardContent } from './Card'
import { ListCard } from './ListCard'
import { ListRow } from './ListRow'

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

async function render(
  element: React.ReactElement,
  theme: Theme
): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <ScopedThemeProvider theme={theme}>{element}</ScopedThemeProvider>
    )
  )
  return host.firstElementChild as HTMLElement
}

function padding(node: Element): number[] {
  const style = getComputedStyle(node)
  return [
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft
  ].map(n => (Number.isNaN(parseFloat(n)) ? 0 : parseFloat(n)))
}

describe('card content spacing', () => {
  for (const base of [tsBallpark, tsDark]) {
    for (const rem of [16, 24]) {
      const theme = { ...base, rem: (n: number) => n * rem }
      const variant = `${base.isDark ? 'dark' : 'light'} at ${rem}`

      it(`pads ordinary content once on all sides: ${variant}`, async () => {
        const card = await render(
          <Card>
            <Text>Empty state</Text>
          </Card>,
          theme
        )
        expect(padding(card)).deep.equals([rem, rem, rem, rem])
        expect(padding(card.firstElementChild!)).deep.equals([0, 0, 0, 0])
      })

      for (const count of [1, 2, 4]) {
        it(`gives all ${count} rows equal insets without outer padding: ${variant}`, async () => {
          const card = await render(
            <ListCard>
              {Array.from({ length: count }, (_, i) => (
                <ListRow
                  key={i}
                  title={`Row ${i}`}
                  subtitle={i % 2 !== 0 ? 'Second line' : undefined}
                  emblem="R"
                />
              ))}
            </ListCard>,
            theme
          )
          expect(padding(card)).deep.equals([0, 0, 0, 0])
          expect(card.children.length).equals(2 * count - 1)
          Array.from(card.children).forEach((node, i) => {
            if (i % 2 === 0) {
              expect(padding(node)).deep.equals([rem, rem, rem, rem])
              const minimum = parseFloat(getComputedStyle(node).minHeight)
              expect(Number.isNaN(minimum) ? 0 : minimum).equals(0)
            } else {
              const style = getComputedStyle(node)
              expect(style.height).equals('1px')
              expect(style.marginLeft).equals(`${rem}px`)
              expect(style.marginRight).equals(`${rem}px`)
              expect(['', '0px']).includes(style.marginTop)
              expect(['', '0px']).includes(style.marginBottom)
            }
          })
        })
      }
    }
  }

  for (const interactive of [false, true]) {
    it(`mutes unavailable row copy without changing default styles (${interactive})`, async () => {
      let presses = 0
      const card = await render(
        <ListCard>
          <ListRow title="Available" subtitle="Details" />
          <ListRow
            title="Unavailable"
            subtitle="Details"
            detail="More detail"
            muted
            disabled
            onPress={
              interactive
                ? () => {
                    presses++
                  }
                : undefined
            }
          />
        </ListCard>,
        tsBallpark
      )
      const title = (value: string): Element =>
        [...card.querySelectorAll('*')].find(n => n.textContent === value)!
      expect(getComputedStyle(title('Unavailable')).color).not.equals(
        getComputedStyle(title('Available')).color
      )
      const action = card.querySelector<HTMLElement>('[role="button"]')
      if (action != null)
        await act(async () => {
          action.click()
        })
      expect(presses).equals(0)
    })
  }

  it('adds dividers only between present sections and preserves row actions', async () => {
    let presses = 0
    const card = await render(
      <ListCard>
        {null}
        <CardContent>
          <Text>Form</Text>
        </CardContent>
        {false}
        {[
          <ListRow
            key="action"
            title="Open row"
            onPress={() => {
              presses++
            }}
          />
        ]}
        {undefined}
      </ListCard>,
      tsBallpark
    )
    expect(card.children.length).equals(3)
    expect(padding(card.children[0])).deep.equals([16, 16, 16, 16])
    const action = card.querySelector<HTMLElement>('[role="button"]')!
    expect(padding(action)).deep.equals([16, 16, 16, 16])
    await act(async () => {
      action.click()
    })
    expect(presses).equals(1)
  })
})
