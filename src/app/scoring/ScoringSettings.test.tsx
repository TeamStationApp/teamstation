import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type DictationModel,
  dictationModelOf,
  type Health
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import { ScoringSettings } from './ScoringSettings'
import { swipeCloses } from './ScoringSheet'

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
function health(dictation: boolean, models: string[]): () => Promise<Health> {
  return async () => ({
    status: 'ok',
    version: '1',
    database: 'ok',
    migrations: 1,
    dictation,
    dictationModels: models
  })
}
async function render(
  userId: string,
  props: Partial<React.ComponentProps<typeof ScoringSettings>> = {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ScoringSettings userId={userId} {...props} />
      </ThemeProvider>
    )
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
function find(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}
function chosen(): string[] {
  return [...document.querySelectorAll('[role="radio"]')]
    .filter(node => node.getAttribute('aria-checked') === 'true')
    .map(node => String(node.getAttribute('aria-label')))
}

describe('the settings sheet', function () {
  it('lists every dictation model first, the server’s ones to pick', async function () {
    const picked: DictationModel[] = []
    await render('models', {
      health: health(true, ['grok-4.3', 'gpt-6-luna', 'claude-haiku-5-5']),
      onDictationModelChange: model => picked.push(model)
    })
    const group = find('Dictation Model')!
    expect(group.textContent).match(/^Dictation Model/)
    expect(
      [...group.querySelectorAll('[role="radio"]')].map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals(['Grok 4.3', 'GPT-6 Luna', 'GPT-6 Sol', 'Claude Haiku 5.5'])
    // Nothing picked yet: the default, which this server offers.
    expect(chosen()).deep.equals(['Claude Haiku 5.5'])
    expect(find('GPT-6 Sol')?.getAttribute('aria-disabled')).equals('true')
    expect(find('GPT-6 Sol')?.textContent).includes('not set up')
    // It comes before the other settings.
    const all = [...document.querySelectorAll('[aria-label]')].map(node =>
      node.getAttribute('aria-label')
    )
    expect(all.indexOf('Dictation Model')).lessThan(
      all.indexOf('Toggle scoring sound')
    )
    await act(async () => {
      find('GPT-6 Luna')!.click()
    })
    expect(chosen()).deep.equals(['GPT-6 Luna'])
    expect(picked).deep.equals(['gpt-6-luna'])
    expect((await scoringPreferences.read('models')).dictationModel).equals(
      'gpt-6-luna'
    )
  })

  it('shows no models where the server takes no dictation', async function () {
    await render('none', { health: health(false, []) })
    expect(find('Dictation Model')).equals(null)
    expect(find('Toggle scoring sound')).not.equals(null)
  })

  it('turns sound and switch-hitter help on and off with switches', async function () {
    const sounds: boolean[] = []
    await render('switches', { onSoundChange: on => sounds.push(on) })
    const on = (label: string): boolean | undefined =>
      document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
        ?.checked
    expect(on('Toggle scoring sound')).equals(true)
    await act(async () => {
      find('Toggle scoring sound')!.click()
    })
    expect(on('Toggle scoring sound')).equals(false)
    expect(sounds).deep.equals([false])
    await act(async () => {
      find('Toggle switch-hitter help')!.click()
    })
    expect(await scoringPreferences.read('switches')).deep.include({
      sound: false,
      help: false
    })
  })

  it('picks the model dictation uses', function () {
    const all = ['grok-4.3', 'claude-haiku-5-5']
    expect(dictationModelOf(undefined, all)).equals('claude-haiku-5-5')
    expect(dictationModelOf('claude-haiku-5-5', all)).equals('claude-haiku-5-5')
    // A pick the server no longer offers falls to the default, or else the
    // first it does offer.
    expect(dictationModelOf('gpt-6-sol', all)).equals('claude-haiku-5-5')
    expect(dictationModelOf('gpt-6-sol', ['gpt-6-luna'])).equals('gpt-6-luna')
    expect(dictationModelOf(undefined, [])).equals(undefined)
  })

  it('closes when pulled far enough down, or flicked', function () {
    expect(swipeCloses(121, 0)).equals(true)
    expect(swipeCloses(60, 1.2)).equals(true)
    expect(swipeCloses(60, 0.2)).equals(false)
    expect(swipeCloses(10, 3)).equals(false)
    expect(swipeCloses(-200, 0)).equals(false)
  })
})
