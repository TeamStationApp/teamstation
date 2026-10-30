/** Real browser journeys. The private fixture owns sessions and synthetic data. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'

interface Browser extends MaestroDevice {
  evalBrowserScript: (options: {
    script: string
    output: string
  }) => Promise<unknown>
  vars: () => Promise<Record<string, unknown>>
}

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function main(): Promise<void> {
  const origin = required('TS_CHAT_WEB_URL')
  const artifacts = required('CHAT117_ARTIFACTS')
  mkdirSync(artifacts, { recursive: true })
  const daemon = await maestroClient().MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: process.env.MAESTRO_D_BIN,
    ...{ signal: AbortSignal.timeout(120000) }
  })
  const browser = async (device: string): Promise<Browser> =>
    (await daemon.attach({
      device,
      platform: 'web',
      url: origin,
      extra: {
        windowSize: process.env.CHAT117_SIZE ?? '430x932',
        headed: false
      }
    })) as Browser
  const a = await browser(required('CHAT117_DEVICE'))
  const read = async <T>(d: Browser, script: string): Promise<T> => {
    await d.evalBrowserScript({
      script: `return JSON.stringify(await (async()=>{${script}})())`,
      output: 'observed'
    })
    return JSON.parse(String((await d.vars()).observed)) as T
  }
  const shot = async (d: Browser, name: string): Promise<void> => {
    writeFileSync(join(artifacts, name + '.png'), await d.screenshot())
    console.log(`Captured ${name}`)
  }
  const tap = async (d: Browser, text: string): Promise<void> => {
    await d.tapOn({ text, timeout: 15000 })
  }
  const visible = async (d: Browser, text: string): Promise<void> => {
    await d.assertVisible({ text, timeout: 15000 })
  }
  const mode = process.argv[2]
  if (mode === 'people') {
    await a.openLink({ link: origin + '/chat' })
    await tap(a, 'New message')
    await tap(a, 'Name')
    await read(
      a,
      `window.__chat117Input=0; performance.clearResourceTimings();
      document.addEventListener('input',()=>{window.__chat117Input=performance.now()});
      return true;`
    )
    await a.inputText({ text: 'Lou' })
    await visible(a, 'Loading…')
    await shot(a, 'people-search-after')
    await visible(a, 'Pick Lou G')
    await tap(a, 'Pick Lou G')
    await visible(a, 'Remove Lou G')
    const state = await read<{
      value: string
      focused: boolean
      calls: number[]
    }>(
      a,
      `const input=document.querySelector('input'); return {value:input.value,focused:document.activeElement===input,calls:performance.getEntriesByType('resource').filter(e=>e.name.includes('/chat/dm-candidates?q=Lou')).map(e=>e.startTime-window.__chat117Input)};`
    )
    assert.equal(state.value, '')
    assert.equal(state.focused, true)
    assert.equal(state.calls.length, 1)
    assert(
      state.calls[0] >= 490,
      'Search must wait at least 500 ms (10 ms clock tolerance)'
    )
    await shot(a, 'people-after')
    console.log('PASS E1 cleared focused field, one delayed request:', state)
    await a.inputText({ text: 'Willie' })
    await visible(a, 'Pick Willie M')
    console.log('PASS E1 next person can be searched without another focus tap')
  } else if (mode === 'approval') {
    const b = await browser(required('CHAT117_REQUESTER'))
    await a.openLink({ link: origin + '/notifications' })
    await b.openLink({ link: origin + '/__fixture/session/L' })
    await visible(b, 'Waiting for approval…')
    await visible(a, 'Chrome on macOS asks to read your chats')
    await shot(a, 'live-approval-after')
    await tap(a, 'Later')
    await visible(a, 'Approve chat device')
    await shot(a, 'notifications-after')
    await tap(a, 'Approve chat device')
    await visible(a, 'Approve Chrome on macOS')
    await shot(a, 'notification-detail-after')
    await tap(a, 'Decline Chrome on macOS')
    await visible(a, 'Declined')
    await visible(b, 'Ask again')
    await b.openLink({ link: origin + '/notifications' })
    await b.openLink({ link: origin + '/chat' })
    await visible(b, 'That request was declined.*')
    assert.equal(
      await read<number>(
        a,
        `return (await (await fetch('/api/v1/chat/links')).json()).length;`
      ),
      0,
      'Reopening Chat must not silently create another request'
    )
    await shot(b, 'link-result-after')
    console.log(
      'PASS E5 notification detail decline closes the prompt and reaches requesting device'
    )
    await tap(b, 'Ask again')
    await visible(a, 'Chrome on macOS asks to read your chats')
    const pending = await read<Array<{ id: string }>>(
      a,
      `return await (await fetch('/api/v1/chat/links')).json();`
    )
    assert.equal(pending.length, 1)
    await tap(a, 'Approve Chrome on macOS')
    await visible(b, 'New message')
    await a.openLink({ link: origin + '/notifications' })
    await tap(a, 'History')
    await visible(a, 'Approved')
    const notice = await read<{ id: string; status: string }>(
      a,
      `const page=await (await fetch('/api/v1/me/notifications?history=1')).json(); return page.items.find(item=>item.requestId===${JSON.stringify(pending[0].id)});`
    )
    assert.equal(notice.status, 'accepted')
    await read(
      a,
      `const rows=[...document.querySelectorAll('[role="button"]')].filter(n=>n.textContent.includes('Approve chat device'));rows.at(-1)?.scrollIntoView();return true;`
    )
    await shot(a, 'approved-history-after')
    await a.openLink({ link: origin + '/notifications/' + notice.id })
    await visible(a, 'Approved')
    console.log(
      'PASS E5 modal approval installs keys and is Approved in notification history'
    )
  } else if (mode === 'layout') {
    await a.openLink({ link: origin + '/__fixture/session/L' })
    await visible(a, 'Waiting for approval…|New message')
    const waiting = await read<boolean>(
      a,
      `return document.body.innerText.includes('Waiting for approval');`
    )
    if (waiting) {
      const approver = await browser(required('CHAT117_APPROVER'))
      await visible(approver, 'Chrome on macOS asks to read your chats')
      await tap(approver, 'Approve Chrome on macOS')
    }
    await visible(a, 'New message')
    await visible(a, 'Spring 2027 - Harbor League.*')
    const geometry = await read<
      Array<{ title: string; left: number; right: number; target: number }>
    >(
      a,
      `return [...document.querySelectorAll('[data-testid^="chat-conversation-cnv_"]')].map(open=>{const row=open.parentElement;const more=row.querySelector('[aria-label^="Conversation actions:"]');if(!more)return null;const icon=more.firstElementChild.getBoundingClientRect(),o=open.getBoundingClientRect(),r=row.getBoundingClientRect(),m=more.getBoundingClientRect();return {title:open.getAttribute('aria-label'),left:icon.left-o.right,right:r.right-icon.right,target:m.width}}).filter(Boolean);`
    )
    assert(geometry.length > 0)
    for (const row of geometry) {
      assert(Math.abs(row.left - row.right) < 1, JSON.stringify(row))
      assert(row.target >= 48)
    }
    const size = await read<number>(a, 'return innerWidth;')
    await shot(a, `layout-${size}-after`)
    console.log(
      `PASS E2 ${size}px balanced ellipsis clearance and minimum touch target`,
      geometry
    )
    await a.openLink({
      link: origin + '/chat/' + required('CHAT117_SEASON_CONVERSATION')
    })
    await visible(a, 'Spring 2027 - Harbor League.*')
    await shot(a, `header-${size}-after`)
  } else if (mode === 'words') {
    const conversation = required('CHAT117_CONVERSATION')
    await a.openLink({ link: origin + '/chat/' + conversation + '/info' })
    await visible(a, 'Safety words with Lou G.*')
    await shot(a, 'chat-info-after')
    await tap(a, 'Safety words with Lou G.*')
    await visible(a, 'Compare these 16 words.*')
    const words = await read<Array<{ word: string; x: number; y: number }>>(
      a,
      `return [...document.querySelectorAll('[data-testid^="chat-safety-group-"]')].map(n=>{const r=n.getBoundingClientRect();return {word:n.textContent,x:r.x,y:r.y}});`
    )
    assert.equal(words.length, 16)
    assert.equal(new Set(words.map(word => Math.round(word.x))).size, 4)
    assert.equal(new Set(words.map(word => Math.round(word.y))).size, 4)
    assert(words.every(word => /^[a-z]+$/.test(word.word)))
    await shot(a, 'safety-after')
    console.log(
      'PASS E3 sixteen words in four columns and four rows',
      words.map(word => word.word).join(' ')
    )
  } else {
    throw new Error('Choose people, approval or words')
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
