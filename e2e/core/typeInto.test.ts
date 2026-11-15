import { expect } from 'chai'

import { typeInto, valueFromHierarchy } from './typeInto'

describe('valueFromHierarchy', function () {
  it('reads a JSON field value by its identifier', function () {
    const raw = JSON.stringify({
      nodes: [
        { identifier: 'E-mail address', value: 'alex@example.com' },
        { identifier: 'Password', value: '••••' }
      ]
    })
    expect(valueFromHierarchy(raw, 'E-mail address')).equals('alex@example.com')
    expect(valueFromHierarchy(raw, 'Password')).equals('••••')
    expect(valueFromHierarchy(raw, 'Missing')).equals(undefined)
  })

  it('reads an XML field value and decodes it', function () {
    const raw =
      '<XCUIElementTypeTextField name="E-mail address" value="a&amp;b@example.com"/>'
    expect(valueFromHierarchy(raw, 'E-mail address')).equals('a&b@example.com')
  })

  it('reports nothing for a field the hierarchy does not value', function () {
    expect(
      valueFromHierarchy(
        '<XCUIElementTypeTextField name="Password"/>',
        'Password'
      )
    ).equals(undefined)
    expect(valueFromHierarchy('{', 'Password')).equals(undefined)
  })
})

describe('typeInto', function () {
  it('leaves a whole string in place when the field holds it', async function () {
    const calls: string[] = []
    await typeInto(
      {
        tapOn: async () => {
          calls.push('tap')
        },
        eraseText: async () => {
          calls.push('erase')
        },
        inputText: async () => {
          calls.push('type')
        },
        hierarchyRaw: async () =>
          Buffer.from(
            JSON.stringify({
              nodes: [
                { identifier: 'E-mail address', value: 'alex@example.com' }
              ]
            })
          )
      },
      'E-mail address',
      'alex@example.com'
    )
    expect(calls).deep.equals(['tap', 'erase', 'type'])
  })

  it('accepts a secure field that reports one bullet per character', async function () {
    const typed: string[] = []
    await typeInto(
      {
        tapOn: async () => undefined,
        eraseText: async () => undefined,
        inputText: async (value: { text: string }) => {
          typed.push(value.text)
        },
        hierarchyRaw: async () =>
          '<XCUIElementTypeSecureTextField name="Password" value="••"/>'
      },
      'Password',
      'pw'
    )
    expect(typed).deep.equals(['pw'])
  })

  it('types one character at a time when the first try dropped keys', async function () {
    const typed: string[] = []
    let reads = 0
    await typeInto(
      {
        tapOn: async () => undefined,
        eraseText: async () => undefined,
        inputText: async (value: { text: string }) => {
          typed.push(value.text)
        },
        hierarchyRaw: async () => {
          reads++
          const value = reads === 1 ? 'ax' : 'ab'
          return JSON.stringify({
            nodes: [{ identifier: 'E-mail address', value }]
          })
        }
      },
      'E-mail address',
      'ab'
    )
    expect(typed).deep.equals(['ab', 'a', 'b'])
  })

  it('trusts the first try when the field value cannot be read', async function () {
    const typed: string[] = []
    await typeInto(
      {
        tapOn: async () => undefined,
        inputText: async (value: { text: string }) => {
          typed.push(value.text)
        }
      },
      'E-mail address',
      'alex@example.com'
    )
    expect(typed).deep.equals(['alex@example.com'])
  })
})
