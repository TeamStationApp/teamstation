/** GUI reply checks use explicitly allocated profiles and private fixture metadata. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import puppeteer from 'puppeteer'

interface Selector {
  text?: string
  css?: string
  timeout?: number
}
interface Device {
  openLink: (options: { link: string }) => Promise<unknown>
  evalBrowserScript: (options: {
    script: string
  }) => Promise<{ data?: unknown }>
  assertVisible: (options: Selector) => Promise<unknown>
  tapOn: (options: Selector) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  blockNetwork: (options: { patterns: string[] }) => Promise<unknown>
  mockNetwork: (options: {
    url: string
    method: string
    response: object
  }) => Promise<unknown>
  setNetworkConditions: (options: {
    offline?: boolean
    latency?: number
    downloadSpeed?: number
    uploadSpeed?: number
  }) => Promise<unknown>
  clearNetworkMocks: () => Promise<unknown>
  scrollUntilVisible: (options: {
    element: Selector
    from?: Selector
    direction: string
    timeout?: number
    centerElement?: boolean
  }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<unknown>
}
interface Fixture {
  conversationId: string
  originalId: string
  originalBody: string
  attachmentId: string
  attachmentReplyId: string
  replyId: string
  replyBody: string
  fileName: string
  fillerCount: number
}
interface CaseResult {
  case: string
  pass: boolean
  [key: string]: unknown
}
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const WEB = required('TS_CHAT_WEB_URL').replace(/\/+$/, '')
const API = required('TS_CHAT_API_URL').replace(/\/+$/, '')
const ARTIFACTS = required('CHAT_UI_REPLY_ARTIFACTS')
const hidden: string[] = []
async function evaluate<T>(device: Device, script: string): Promise<T> {
  const result = await device.evalBrowserScript({ script })
  return (
    typeof result.data === 'string' ? JSON.parse(result.data) : result.data
  ) as T
}
async function signIn(device: Device): Promise<number> {
  const actor = required('CHAT_UI_REPLY_ACTOR')
  let who: { userId: number; email: string; password: string } | undefined
  for (const line of readFileSync(
    required('CHAT_UI_REPLY_SEED_FILE'),
    'utf8'
  ).split('\n')) {
    const match = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
    if (match?.[1] === actor)
      who = { userId: Number(match[2]), email: match[3], password: match[4] }
  }
  assert(who != null, 'Explicit fixture actor missing')
  hidden.push(who.password)
  await device.openLink({ link: WEB })
  const authScript = `const r=await fetch(${JSON.stringify(API + '/auth/me')},{credentials:'include'});return JSON.stringify({status:r.status,id:r.ok?Number((await r.json()).id):null});`
  let auth = await evaluate<{ status: number; id: number | null }>(
    device,
    authScript
  )
  for (let attempt = 0; attempt < 10 && auth.status !== 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    auth = await evaluate(device, authScript)
  }
  if (auth.status !== 200) {
    await device.tapOn({ text: 'Use a password instead', timeout: 45000 })
    await device.tapOn({ text: 'E-mail address' })
    await device.inputText({ text: who.email })
    await device.tapOn({ text: 'Password' })
    await device.inputText({ text: who.password })
    await device.tapOn({ text: 'Sign in' })
    await device.assertVisible({ text: 'Follow a team', timeout: 45000 })
    auth = await evaluate(device, authScript)
  }
  assert.equal(auth.status, 200, 'Normal GUI sign-in must finish')
  assert.equal(
    auth.id,
    who.userId,
    'Allocated profile must use the assigned actor'
  )
  return who.userId
}
function row(id: string): string {
  return `[data-testid=${JSON.stringify('chat-message-' + id)}]`
}
function quote(id: string): string {
  return `${row(id)} [role="button"][aria-label^="Jump to message from "]`
}
async function coldOpen(device: Device, fixture: Fixture): Promise<void> {
  await device.openLink({
    link: `${WEB}/chat/${fixture.conversationId}?replyProbe=${Date.now()}`
  })
  await evaluate(
    device,
    `for(let n=0;n<120;n++){const row=document.querySelector(${JSON.stringify(row(fixture.replyId))});if(row){row.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,400));return true}await new Promise(r=>setTimeout(r,250))}throw new Error('Allocated retained reply missing');`
  )
  await device.assertVisible({ css: row(fixture.replyId), timeout: 45000 })
}
async function state(
  device: Device,
  fixture: Fixture
): Promise<{ top: number; original: boolean; label: string; errors: number }> {
  return await evaluate(
    device,
    `const pane=document.querySelector('[data-testid="chat-message-pane"]');const scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');return JSON.stringify({top:scroll.scrollTop,original:!!document.querySelector(${JSON.stringify(row(fixture.originalId))}),label:document.querySelector(${JSON.stringify(quote(fixture.replyId))})?.getAttribute('aria-label')||'',errors:(document.body.textContent.match(/Message unavailable/g)||[]).length});`
  )
}
async function capture(device: Device, name: string): Promise<void> {
  writeFileSync(join(ARTIFACTS, `${name}.png`), await device.screenshot())
}
async function shared(device: Device, results: CaseResult[]): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(required('CHAT_UI_REPLY_SHARED_FIXTURE'), 'utf8')
  ) as Fixture
  assert(
    fixture.fillerCount >= 100,
    'Shared fixture must include more than one history page'
  )
  await coldOpen(device, fixture)
  const before = await state(device, fixture)
  assert.equal(
    before.original,
    false,
    'Old original must actually be absent before paging'
  )
  assert(
    before.label.includes('Message unavailable'),
    'Unloaded original must not expose the cached snippet'
  )
  const wire = await evaluate<Array<{ id: string; seq: number }>>(
    device,
    `const list=await (await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'})).json();const current=list.find(chat=>chat.id===${JSON.stringify(fixture.conversationId)});if(!current)throw new Error('Owned shared conversation unavailable');const r=await fetch(${JSON.stringify(API + '/chat/conversations/' + fixture.conversationId + '/messages?limit=100&before=')}+(current.lastSeq+1),{credentials:'include'});if(!r.ok)throw new Error('Own encrypted metadata unavailable');const rows=await r.json();if(JSON.stringify(rows).includes(${JSON.stringify(fixture.originalBody)}))throw new Error('Plaintext appeared in encrypted wire');return JSON.stringify(rows.map(row=>({id:row.id,seq:row.seq})));`
  )
  assert(
    !wire.some(entry => entry.id === fixture.originalId),
    'Original must lie beyond the current raw page'
  )
  console.log('$ S7 own-page history request failure and position retention')
  await device.blockNetwork({
    patterns: [
      `*api/v1/chat/conversations/${fixture.conversationId}/messages*before=*`
    ]
  })
  try {
    await device.tapOn({ css: quote(fixture.replyId) })
    let failed = await state(device, fixture)
    for (
      let attempt = 0;
      attempt < 20 && failed.errors <= before.errors;
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 100))
      failed = await state(device, fixture)
    }
    assert(
      failed.errors > before.errors,
      'Failed history request must present explicit feedback'
    )
    assert.equal(
      failed.original,
      false,
      'Failed history must not invent an original'
    )
    assert(
      Math.abs(failed.top - before.top) <= 2,
      'Failed paging must leave the reading position unchanged'
    )
    results.push({
      case: 'history failure',
      pass: true,
      before: before.top,
      after: failed.top
    })
    await capture(device, 'reply-history-failure')
  } finally {
    await device.clearNetworkMocks()
  }
  console.log(
    '$ S7 cold history jump, authoritative long self quote and attachment quote'
  )
  await coldOpen(device, fixture)
  await device.tapOn({ css: quote(fixture.replyId) })
  await device.assertVisible({ css: row(fixture.originalId), timeout: 45000 })
  const excerpt =
    Array.from(fixture.originalBody).slice(0, 200).join('') +
    (Array.from(fixture.originalBody).length > 200 ? '…' : '')
  const resolvedScript = `const original=document.querySelector(${JSON.stringify(row(fixture.originalId))});const target=document.querySelector(${JSON.stringify(quote(fixture.replyId))});const name=target?.firstElementChild;const rect=original.getBoundingClientRect();return JSON.stringify({label:target?.getAttribute('aria-label')||'',quoteCount:document.querySelector(${JSON.stringify(row(fixture.replyId))}).querySelectorAll('[aria-label^="Jump to message from "]').length,bold:Number(getComputedStyle(name).fontWeight)>=600,visible:rect.top>=0&&rect.top<innerHeight});`
  let resolved = await evaluate<{
    label: string
    quoteCount: number
    bold: boolean
    visible: boolean
  }>(device, resolvedScript)
  for (let attempt = 0; attempt < 30 && !resolved.visible; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    resolved = await evaluate(device, resolvedScript)
  }
  if (!resolved.visible) {
    const geometry = await evaluate<object>(
      device,
      `const original=document.querySelector(${JSON.stringify(row(fixture.originalId))});const pane=document.querySelector('[data-testid="chat-message-pane"]');const scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');const box=original.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();return JSON.stringify({original:{top:box.top,bottom:box.bottom,height:box.height},viewport:{top:viewport.top,bottom:viewport.bottom,height:viewport.height},scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,windowScrollY:scrollY,errors:(document.body.textContent.match(/Message unavailable/g)||[]).length});`
    )
    results.push({ case: 'old original jump', pass: false, geometry })
    await capture(device, 'reply-history-jump-failure')
  }
  if (resolved.visible) results.push({ case: 'old original jump', pass: true })
  assert(
    resolved.label.includes(`You: ${excerpt}`),
    'Accessible quote must resolve current original and 200-code-point excerpt'
  )
  assert.equal(resolved.quoteCount, 1, 'Quote must use one inset')
  assert(resolved.bold, 'Resolved sender must be bold')
  results.push({
    case: 'authoritative long self quote',
    pass: true,
    rawPageSize: wire.length
  })
  await evaluate(
    device,
    `const pane=document.querySelector('[data-testid="chat-message-pane"]');const scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));document.querySelector(${JSON.stringify(row(fixture.replyId))}).scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,400));const quote=document.querySelector(${JSON.stringify(quote(fixture.replyId))}),box=quote.getBoundingClientRect(),view=scroll.getBoundingClientRect();if(box.top<view.top||box.bottom>view.bottom)throw new Error('Long quote evidence must actually be visible');return true;`
  )
  await capture(device, 'reply-long-self-resolved')
  await evaluate(
    device,
    `const pane=document.querySelector('[data-testid="chat-message-pane"]');const scroll=[...pane.querySelectorAll('div')].find(n=>getComputedStyle(n).overflowY==='auto');scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));document.querySelector(${JSON.stringify(row(fixture.attachmentReplyId))}).scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,400));const quote=document.querySelector(${JSON.stringify(quote(fixture.attachmentReplyId))}),box=quote.getBoundingClientRect(),view=scroll.getBoundingClientRect();if(box.top<view.top||box.bottom>view.bottom)throw new Error('Attachment quote evidence must actually be visible');return true;`
  )
  const attachment = await evaluate<{ label: string; quoteCount: number }>(
    device,
    `const row=document.querySelector(${JSON.stringify(row(fixture.attachmentReplyId))});return JSON.stringify({label:row.querySelector('[aria-label^="Jump to message from "]')?.getAttribute('aria-label')||'',quoteCount:row.querySelectorAll('[aria-label^="Jump to message from "]').length});`
  )
  assert(
    attachment.label.includes(fixture.fileName),
    'Attachment-only quote must use its decrypted filename'
  )
  assert.equal(attachment.quoteCount, 1)
  results.push({ case: 'attachment quote', pass: true })
  await capture(device, 'reply-attachment')
}
interface Envelope {
  id: string
  kind: string
  seq: number
  senderUserId: number
}
async function envelopes(device: Device, id: string): Promise<Envelope[]> {
  return await evaluate(
    device,
    `const r=await fetch(${JSON.stringify(API + '/chat/conversations/')}+${JSON.stringify(id)}+'/messages',{credentials:'include'});if(!r.ok)throw new Error('Own message metadata unavailable');return JSON.stringify((await r.json()).map(row=>({id:row.id,kind:row.kind,seq:row.seq,senderUserId:row.senderUserId})));`
  )
}
async function sent(
  device: Device,
  id: string,
  before: Envelope[]
): Promise<string> {
  let rows: Envelope[] = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    rows = await envelopes(device, id)
    const added = rows.filter(
      entry => entry.kind === 'post' && !before.some(old => old.id === entry.id)
    )
    if (added.length > 0) {
      assert.equal(added.length, 1, 'One normal Send must create one post')
      await device.assertVisible({ css: row(added[0].id), timeout: 20000 })
      return added[0].id
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Normal GUI Send did not produce a post')
}
async function send(device: Device, id: string, body: string): Promise<string> {
  const before = await envelopes(device, id)
  await device.tapOn({ css: '[data-testid="chat-composer"]' })
  await device.inputText({ text: body })
  await device.tapOn({ text: 'Send' })
  return await sent(device, id, before)
}
async function reply(device: Device, id: string): Promise<void> {
  await device.tapOn({ css: row(id) })
  await device.tapOn({ css: `${row(id)} [aria-label="Reply"]`, timeout: 10000 })
  await device.assertVisible({ text: 'Cancel reply', timeout: 10000 })
}
async function more(device: Device, id: string): Promise<void> {
  await device.tapOn({ css: row(id) })
  await device.tapOn({
    css: `${row(id)} [aria-label="More message actions"]`,
    timeout: 10000
  })
}
async function small(device: Device, results: CaseResult[]): Promise<void> {
  const peer = required('CHAT_UI_REPLY_PEER')
  let peerId: number | undefined
  for (const line of readFileSync(
    required('CHAT_UI_REPLY_SEED_FILE'),
    'utf8'
  ).split('\n')) {
    const match = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
    if (match?.[1] === peer) peerId = Number(match[2])
  }
  assert(peerId != null, 'Assigned peer is required')
  await device.openLink({ link: `${WEB}/chat` })
  await device.assertVisible({ text: 'New message', timeout: 20000 })
  const candidate = await evaluate<{
    userId: number
    shortName: string
  } | null>(
    device,
    `const r=await fetch(${JSON.stringify(API + '/chat/dm-candidates?q=')},{credentials:'include'});if(!r.ok)throw new Error('Own candidate metadata unavailable');const person=(await r.json()).find(person=>Number(person.userId)===${peerId});return JSON.stringify(person?{userId:person.userId,shortName:person.shortName}:null);`
  )
  assert(
    candidate != null,
    'Assigned adult peer must be a normal eligible candidate'
  )
  await device.tapOn({ text: 'New message' })
  await device.tapOn({
    css: `[role="button"][aria-label=${JSON.stringify('Pick ' + candidate.shortName)}]`,
    timeout: 20000
  })
  await device.tapOn({ text: 'Start conversation' })
  await device.assertVisible({
    css: '[data-testid="chat-composer"]',
    timeout: 20000
  })
  const id = await evaluate<string>(
    device,
    `const parts=location.pathname.split('/');if(parts[1]!=='chat'||!parts[2]?.startsWith('cnv_'))throw new Error('Normal DM route missing');return JSON.stringify(parts[2]);`
  )
  const sharedId = (
    JSON.parse(
      readFileSync(required('CHAT_UI_REPLY_SHARED_FIXTURE'), 'utf8')
    ) as Fixture
  ).conversationId
  assert.notEqual(
    id,
    sharedId,
    'Destructive cases must stay outside the shared history fixture'
  )
  assert.notEqual(
    id,
    required('CHAT_UI_REPLY_PROTECTED_CONVERSATION'),
    'Original baseline room is protected'
  )
  const originalBody = `Disposable reply original ${Date.now()}`
  const originalId = await send(device, id, originalBody)
  writeFileSync(
    join(ARTIFACTS, 'small-fixture.json'),
    `${JSON.stringify({ conversationId: id, originalId, originalBody, peerLabel: candidate.shortName }, null, 2)}\n`
  )
  console.log('$ S7 cancel preserves actual draft and prepared attachment')
  await reply(device, originalId)
  await device.tapOn({ css: '[data-testid="chat-composer"]' })
  await device.inputText({ text: 'A retained draft' })
  await evaluate(
    device,
    `const transfer=new DataTransfer();transfer.items.add(new File(['Fixture notes'],'reply-draft.txt',{type:'text/plain'}));document.querySelector('[data-testid="chat-drop-target"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true;`
  )
  await device.assertVisible({ text: 'Remove reply-draft.txt', timeout: 10000 })
  await device.tapOn({ text: 'Cancel reply' })
  const retained = await evaluate<{
    text: string
    file: boolean
    reply: boolean
  }>(
    device,
    `return JSON.stringify({text:document.querySelector('[data-testid="chat-composer"]').value,file:!!document.querySelector('[aria-label="Remove reply-draft.txt"]'),reply:!!document.querySelector('[aria-label="Cancel reply"]')});`
  )
  assert.equal(retained.text, 'A retained draft')
  assert.equal(retained.file, true)
  assert.equal(retained.reply, false)
  results.push({ case: 'reply cancel retains draft and file', pass: true })
  console.log(
    '$ S7 scoped send failure retains reply draft and file; retry creates one encrypted post'
  )
  await reply(device, originalId)
  const before = await envelopes(device, id)
  await device.blockNetwork({
    patterns: [`*api/v1/chat/conversations/${id}/messages*`]
  })
  try {
    await device.tapOn({ text: 'Send' })
    await device.assertVisible({
      text: 'That did not send. Try again.',
      timeout: 20000
    })
    const failed = await evaluate<{
      text: string
      file: boolean
      reply: boolean
    }>(
      device,
      `return JSON.stringify({text:document.querySelector('[data-testid="chat-composer"]').value,file:!!document.querySelector('[aria-label="Remove reply-draft.txt"]'),reply:!!document.querySelector('[aria-label="Cancel reply"]')});`
    )
    assert.equal(failed.text, 'A retained draft')
    assert.equal(failed.file, true)
    assert.equal(failed.reply, true)
  } finally {
    await device.clearNetworkMocks()
  }
  assert.equal(
    (await envelopes(device, id)).length,
    before.length,
    'Blocked normal request must not reach the server'
  )
  await device.tapOn({ text: 'Send' })
  const replyId = await sent(device, id, before)
  const clean = await evaluate<{ text: string; file: boolean; reply: boolean }>(
    device,
    `return JSON.stringify({text:document.querySelector('[data-testid="chat-composer"]').value,file:!!document.querySelector('[aria-label="Remove reply-draft.txt"]'),reply:!!document.querySelector('[aria-label="Cancel reply"]')});`
  )
  assert.equal(clean.text, '')
  assert.equal(clean.file, false)
  assert.equal(clean.reply, false)
  results.push({
    case: 'failed send retention and exact single retry',
    pass: true
  })
  await reply(device, replyId)
  const nestedId = await send(device, id, 'Reply to the reply itself')
  const nested = await evaluate<{ label: string; count: number }>(
    device,
    `const target=document.querySelector(${JSON.stringify(row(nestedId))});return JSON.stringify({label:target.querySelector('[aria-label^="Jump to message from "]')?.getAttribute('aria-label')||'',count:target.querySelectorAll('[aria-label^="Jump to message from "]').length});`
  )
  assert.equal(nested.count, 1)
  assert(nested.label.includes('A retained draft'))
  assert(
    !nested.label.includes(originalBody),
    'Reply-to-reply must not nest the earlier original'
  )
  results.push({
    case: 'reply to reply uses own content without nested quote',
    pass: true
  })
  console.log(
    '$ S7 own original deletion clears quote snapshot and personal pin'
  )
  await more(device, originalId)
  await device.tapOn({ text: 'Pin' })
  const pinScript = `const r=await fetch(${JSON.stringify(API + '/chat/conversations/')}+${JSON.stringify(id)}+'/pins',{credentials:'include'});if(!r.ok)throw new Error('Own pin metadata unavailable');return JSON.stringify(await r.json());`
  let pins = await evaluate<Array<{ messageId: string }>>(device, pinScript)
  for (
    let attempt = 0;
    attempt < 30 && !pins.some(pin => pin.messageId === originalId);
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 100))
    pins = await evaluate(device, pinScript)
  }
  assert(
    pins.some(pin => pin.messageId === originalId),
    'Normal Pin must finish before its deletion test'
  )
  await more(device, originalId)
  await device.tapOn({ text: 'Delete' })
  await device.assertVisible({
    text: 'This message will be removed for everyone.',
    timeout: 10000
  })
  await device.tapOn({ text: 'Delete' })
  let deleted = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    deleted = await evaluate(
      device,
      `return JSON.stringify(document.querySelector(${JSON.stringify(quote(replyId))})?.getAttribute('aria-label')||'');`
    )
    if (deleted.includes('Message deleted')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(
    deleted.includes('Message deleted'),
    'The actual deleted quote must expose its safe placeholder'
  )
  assert(
    !deleted.includes(originalBody),
    'Deleted quote must not retain a cached snippet'
  )
  assert(
    !(await evaluate<Array<{ messageId: string }>>(device, pinScript)).some(
      pin => pin.messageId === originalId
    ),
    'Deletion must purge the personal pin'
  )
  results.push({
    case: 'own deletion placeholder and pin purge',
    pass: true,
    conversationId: id,
    originalId,
    replyId,
    nestedId
  })
  await capture(device, 'reply-own-deleted-placeholder')
}
async function paging(device: Device, results: CaseResult[]): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(required('CHAT_UI_REPLY_SHARED_FIXTURE'), 'utf8')
  ) as Fixture
  await coldOpen(device, fixture)
  const before = await state(device, fixture)
  assert.equal(before.original, false)
  console.log(
    '$ S7 own-page empty history exhaustion without cached snapshot or position change'
  )
  await device.mockNetwork({
    url: `*api/v1/chat/conversations/${fixture.conversationId}/messages*before=*`,
    method: 'GET',
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '[]'
    }
  })
  try {
    await device.tapOn({ css: quote(fixture.replyId) })
    let exhausted = await state(device, fixture)
    for (
      let attempt = 0;
      attempt < 30 && exhausted.errors <= before.errors;
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 100))
      exhausted = await state(device, fixture)
    }
    assert(
      exhausted.errors > before.errors,
      'Exhausted history must give explicit feedback'
    )
    assert.equal(exhausted.original, false)
    assert(
      Math.abs(exhausted.top - before.top) <= 2,
      'Exhausted paging must keep reading position'
    )
    assert(exhausted.label.includes('Message unavailable'))
    results.push({
      case: 'scoped empty-page exhaustion',
      pass: true,
      protocolMock: true
    })
    await capture(device, 'reply-history-exhausted')
  } finally {
    await device.clearNetworkMocks()
  }
  await coldOpen(device, fixture)
  const target = JSON.parse(
    readFileSync(required('CHAT_UI_REPLY_SMALL_FIXTURE'), 'utf8')
  ) as { conversationId: string; peerLabel: string }
  assert(target.peerLabel !== '', 'Private small-room peer label is required')
  console.log(
    '$ S7 delayed own-page request cancelled by a normal conversation selection'
  )
  const next = await evaluate<{ label: string }>(
    device,
    `const pane=document.querySelector('[data-testid="chat-list-pane"]');const row=[...pane.querySelectorAll('[role="button"][aria-label]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(target.peerLabel)});if(!row)throw new Error('Allocated small-room row must be visible');return JSON.stringify({label:row.getAttribute('aria-label')});`
  )
  await device.setNetworkConditions({
    latency: 1500,
    downloadSpeed: -1,
    uploadSpeed: -1
  })
  try {
    await evaluate(
      device,
      `document.querySelector(${JSON.stringify(quote(fixture.replyId))}).click();return true;`
    )
    await device.tapOn({ text: next.label })
    await new Promise(resolve => setTimeout(resolve, 1800))
    const cancelled = await evaluate<{
      selected: boolean
      oldOriginal: boolean
      feedback: boolean
    }>(
      device,
      `return JSON.stringify({selected:location.pathname.includes(${JSON.stringify(target.conversationId)}),oldOriginal:!!document.querySelector(${JSON.stringify(row(fixture.originalId))}),feedback:document.querySelector('[data-testid="chat-message-pane"]')?.textContent.includes('Message unavailable')===true});`
    )
    assert.equal(cancelled.selected, true)
    assert.equal(cancelled.oldOriginal, false)
    assert.equal(
      cancelled.feedback,
      false,
      'Cancelled old jump must not place feedback into the new conversation'
    )
    results.push({
      case: 'conversation-switch cancellation',
      pass: true,
      scopedNetworkLatency: true
    })
  } finally {
    await device.setNetworkConditions({
      offline: false,
      latency: 0,
      downloadSpeed: -1,
      uploadSpeed: -1
    })
    await device.clearNetworkMocks()
  }
}
interface IncomingFixture {
  conversationId: string
  targetId: string
  targetBody: string
  targetEarlierBody: string
  senderUserId: number
  receiverUserId: number
  incomingId?: string
  incomingBody?: string
  attemptedSend?: boolean
  outgoingId?: string
  outgoingBody?: string
  outgoingSenderName?: string
  attemptedOutgoingSend?: boolean
}
async function incoming(
  device: Device,
  results: CaseResult[],
  userId: number,
  create: boolean
): Promise<void> {
  const fixturePath = required('CHAT_UI_REPLY_INCOMING_FIXTURE')
  const fixture = JSON.parse(
    readFileSync(fixturePath, 'utf8')
  ) as IncomingFixture
  assert.equal(userId, create ? fixture.senderUserId : fixture.receiverUserId)
  await device.openLink({ link: `${WEB}/chat/${fixture.conversationId}` })
  await device.assertVisible({ css: row(fixture.targetId), timeout: 45000 })
  const existing = await envelopes(device, fixture.conversationId)
  assert.equal(
    existing.find(entry => entry.id === fixture.targetId)?.senderUserId,
    fixture.receiverUserId,
    'The incoming quote must target the receiving actor’s own post'
  )
  if (create) {
    assert(
      fixture.attemptedSend !== true && fixture.incomingId == null,
      'Do not duplicate an attempted fixture Send'
    )
    await reply(device, fixture.targetId)
    fixture.incomingBody = 'Incoming reply notes'
    fixture.attemptedSend = true
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
    fixture.incomingId = await send(
      device,
      fixture.conversationId,
      fixture.incomingBody
    )
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
    assert.equal(
      (await envelopes(device, fixture.conversationId)).find(
        entry => entry.id === fixture.incomingId
      )?.senderUserId,
      fixture.senderUserId,
      'The normal encrypted post must belong to the other actor'
    )
    results.push({
      case: 'one normal other-actor reply setup',
      pass: true,
      incomingId: fixture.incomingId
    })
    await capture(device, 'reply-incoming-sender')
    return
  }
  assert(
    fixture.incomingId != null && fixture.incomingBody != null,
    'Verified other-actor post required'
  )
  await device.assertVisible({ css: row(fixture.incomingId), timeout: 45000 })
  const current = await evaluate<{
    label: string
    bodyVisible: boolean
    quoteCount: number
    sender: string
    bold: boolean
    width: number
    quoteInside: boolean
  }>(
    device,
    `const post=document.querySelector(${JSON.stringify(row(fixture.incomingId))});const target=post.querySelector('[aria-label^="Jump to message from "]');const name=target.firstElementChild;const box=post.getBoundingClientRect(),inset=target.getBoundingClientRect();return JSON.stringify({label:target.getAttribute('aria-label'),bodyVisible:post.textContent.includes(${JSON.stringify(fixture.incomingBody)}),quoteCount:post.querySelectorAll('[aria-label^="Jump to message from "]').length,sender:name.textContent,bold:Number(getComputedStyle(name).fontWeight)>=600,width:innerWidth,quoteInside:inset.left>=box.left&&inset.right<=box.right&&inset.top>=box.top&&inset.bottom<=box.bottom});`
  )
  assert.equal(current.label, `Jump to message from You: ${fixture.targetBody}`)
  assert.equal(current.sender, 'You')
  assert.equal(current.bold, true)
  assert.equal(current.bodyVisible, true)
  assert.equal(current.quoteCount, 1)
  assert.equal(
    current.quoteInside,
    true,
    'The single inset must fit its incoming bubble'
  )
  assert(
    !current.label.includes(fixture.targetEarlierBody),
    'An incoming reply-to-reply must use the target body without nesting its earlier quote'
  )
  assert.equal(
    (await envelopes(device, fixture.conversationId)).find(
      entry => entry.id === fixture.incomingId
    )?.senderUserId,
    fixture.senderUserId
  )
  results.push({
    case: 'incoming reply resolves receiving actor as You without nesting an earlier quote',
    pass: true,
    width: current.width,
    incomingId: fixture.incomingId
  })
  await capture(device, 'reply-incoming-receiver')
  if (process.env.CHAT_UI_REPLY_CREATE_OUTGOING === 'true') {
    assert(
      fixture.attemptedOutgoingSend !== true && fixture.outgoingId == null,
      'Do not duplicate an attempted outgoing fixture Send'
    )
    const author = await evaluate<{ shortName: string } | null>(
      device,
      `const r=await fetch(${JSON.stringify(API + '/chat/conversations/' + fixture.conversationId + '/members')},{credentials:'include'});if(!r.ok)throw new Error('Current author metadata unavailable');const author=(await r.json()).find(member=>Number(member.userId)===${fixture.senderUserId});return JSON.stringify(author?{shortName:author.shortName}:null);`
    )
    assert(author != null, 'The other actor must remain an accessible member')
    fixture.outgoingSenderName = author.shortName
    await reply(device, fixture.incomingId)
    fixture.outgoingBody = 'Outgoing reply notes'
    fixture.attemptedOutgoingSend = true
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
    fixture.outgoingId = await send(
      device,
      fixture.conversationId,
      fixture.outgoingBody
    )
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
  }
  assert(
    fixture.outgoingId != null && fixture.outgoingSenderName != null,
    'The verified outgoing reply to the other actor is required'
  )
  await device.assertVisible({ css: row(fixture.outgoingId), timeout: 45000 })
  const outgoing = await evaluate<{
    label: string
    quoteCount: number
    sender: string
    bold: boolean
    quoteInside: boolean
  }>(
    device,
    `const post=document.querySelector(${JSON.stringify(row(fixture.outgoingId))});const target=post.querySelector('[aria-label^="Jump to message from "]');const name=target.firstElementChild;const box=post.getBoundingClientRect(),inset=target.getBoundingClientRect();return JSON.stringify({label:target.getAttribute('aria-label'),quoteCount:post.querySelectorAll('[aria-label^="Jump to message from "]').length,sender:name.textContent,bold:Number(getComputedStyle(name).fontWeight)>=600,quoteInside:inset.left>=box.left&&inset.right<=box.right&&inset.top>=box.top&&inset.bottom<=box.bottom});`
  )
  assert.equal(
    outgoing.label,
    `Jump to message from ${fixture.outgoingSenderName}: ${fixture.incomingBody}`
  )
  assert.equal(outgoing.sender, fixture.outgoingSenderName)
  assert.notEqual(outgoing.sender, 'You')
  assert.equal(outgoing.bold, true)
  assert.equal(outgoing.quoteCount, 1)
  assert.equal(outgoing.quoteInside, true)
  assert(
    !outgoing.label.includes(fixture.targetBody),
    'An outgoing reply must quote only the other actor’s own body'
  )
  assert.equal(
    (await envelopes(device, fixture.conversationId)).find(
      entry => entry.id === fixture.outgoingId
    )?.senderUserId,
    fixture.receiverUserId
  )
  results.push({
    case: 'outgoing reply names the other actor and quotes only that actor’s body',
    pass: true,
    width: current.width,
    outgoingId: fixture.outgoingId
  })
  await capture(device, 'reply-outgoing-other')
}
async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true })
  const { MaestroD } = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    idleTimeout: 0,
    bin: required('MAESTRO_D_BIN')
  })
  const results: CaseResult[] = []
  let device: Device | undefined
  let viewport: { width: number; height: number } | undefined
  try {
    const browser = await puppeteer.executablePath()
    device = await daemon.attach({
      device: required('CHAT_UI_REPLY_WEB_DEVICE'),
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'none',
      extra: {
        browser,
        userDataDir: required('CHAT_UI_REPLY_PROFILE_DIR'),
        windowSize: process.env.CHAT_UI_REPLY_WINDOW_SIZE ?? '1440x1000'
      }
    })
    const ua = (
      await device.evalBrowserScript({ script: 'return navigator.userAgent' })
    ).data
    assert(
      typeof ua === 'string' && ua.includes('Chrome/153.'),
      'Actual awaited Chrome153 is required'
    )
    const userId = await signIn(device)
    viewport = await evaluate<{ width: number; height: number }>(
      device,
      'return JSON.stringify({width:innerWidth,height:innerHeight});'
    )
    assert.equal(
      viewport.width,
      Number(
        (process.env.CHAT_UI_REPLY_WINDOW_SIZE ?? '1440x1000').split('x')[0]
      ),
      'The requested viewport width must actually be active'
    )
    if (process.env.CHAT_UI_REPLY_MODE === 'incoming-send')
      await incoming(device, results, userId, true)
    else if (process.env.CHAT_UI_REPLY_MODE === 'incoming')
      await incoming(device, results, userId, false)
    else if (process.env.CHAT_UI_REPLY_MODE === 'small')
      await small(device, results)
    else if (process.env.CHAT_UI_REPLY_MODE === 'paging')
      await paging(device, results)
    else await shared(device, results)
    assert(
      results.every(result => result.pass),
      'One or more actual reply checks failed'
    )
  } finally {
    await device?.clearNetworkMocks().catch(() => undefined)
    await device?.detach()
    await daemon.shutdown({ wait: true })
    writeFileSync(
      join(ARTIFACTS, 'reply-results.json'),
      `${JSON.stringify({ cases: results, viewport, released: true }, null, 2)}\n`
    )
  }
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of hidden)
    message = message.split(secret).join('<redacted>')
  console.error(message)
  process.exitCode = 1
})
