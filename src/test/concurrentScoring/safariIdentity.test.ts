import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { ConcurrentScoringSafariRig } from './concurrentScoringSafari'
import type { E2eContext } from './context'

class SafariRig extends ConcurrentScoringSafariRig {
  async openScorer(): Promise<void> {
    await this.openClient('scorer-a', 0)
  }
}

describe('Safari scoring fixture identity', () => {
  for (const previousEmail of ['previous@example.test', 'current@example.test'])
    it(`verifies the email when the account label is reused (${previousEmail})`, async () => {
      let email = previousEmail
      let signed = true
      const inputs: string[] = []
      const links: string[] = []
      let signouts = 0
      const m = {
        setOrientation: async () => {},
        stopApp: async () => {},
        launchApp: async () => {},
        openLink: async ({ link }: { link: string }) => {
          links.push(link)
        },
        assertVisible: async () => {},
        scrollUntilVisible: async () => {},
        tapOn: async ({ text }: { text: string }) => {
          if (text === '^Sign out$') {
            signed = false
            signouts++
          }
        },
        hierarchy: async () => ({
          children: signed
            ? [{ text: 'Account, Mike Trout' }, { text: email }]
            : [
                { text: 'Use a password instead' },
                {
                  type: 'WebView',
                  children: [
                    {
                      type: 'TextField',
                      bounds: { x: 0, y: 0, width: 100, height: 40 }
                    },
                    {
                      type: 'SecureTextField',
                      bounds: { x: 0, y: 40, width: 100, height: 40 }
                    }
                  ]
                }
              ]
        }),
        tapOnPoint: async () => {},
        inputText: async ({ text }: { text: string }) => {
          inputs.push(text)
        },
        hideKeyboard: async () => {
          if (inputs.length === 2) {
            email = inputs[0]
            signed = true
          }
        }
      }
      const rig = new SafariRig({
        stack: { origin: 'https://score.example.test' },
        attach: async () => m
      } as unknown as E2eContext)
      rig.fixture = {
        world: 'concurrent-scoring',
        nonce: 'current',
        accounts: {
          'scorer-a': {
            email: 'current@example.test',
            password: 'fixture-placeholder',
            displayName: 'Mike Trout',
            userId: 'fixture-current'
          }
        },
        ids: { game: 'fixture-game' }
      }
      await rig.openScorer()
      assert.equal(email, 'current@example.test')
      assert.equal(signouts, previousEmail === email ? 0 : 1)
      assert.equal(inputs.length, signouts * 2)
      assert.equal(
        links.at(-1),
        'https://score.example.test/games/fixture-game/score'
      )
      assert(links.filter(link => link.endsWith('/account')).length >= 2)
    })
})
