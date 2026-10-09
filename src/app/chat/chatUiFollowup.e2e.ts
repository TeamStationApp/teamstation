/** Functional follow-up scenarios run only on explicitly supplied fixture surfaces. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import puppeteer from 'puppeteer'

interface Device {
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  openTab: (options: { url: string; tabLabel: string }) => Promise<unknown>
  assertVisible: (options: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  tapOn: (options: {
    text?: string
    css?: string
    optional?: boolean
    timeout?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  pressKey: (options: { key: string }) => Promise<unknown>
  longPressOn: (options: { text: string; duration: number }) => Promise<unknown>
  setOrientation: (options: { orientation: string }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  close: () => Promise<unknown>
}
function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const WEB = required('TS_CHAT_WEB_URL').replace(/\/+$/, '')
const API = required('TS_CHAT_API_URL').replace(/\/+$/, '')
const hidden: string[] = []

async function signIn(device: Device, key: string): Promise<void> {
  let credentials: { email: string; password: string } | undefined
  for (const line of readFileSync(required('CHAT_UI_SEED_FILE'), 'utf8').split(
    '\n'
  )) {
    const match = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
    if (match?.[1] === key)
      credentials = { email: match[3], password: match[4] }
  }
  assert(credentials != null, 'Fixture sign-in unavailable')
  hidden.push(credentials.password)
  await device.openLink({ link: WEB })
  const authorized = (await device.evalBrowserScript({
    script: `return (await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'})).status === 200`
  })) as { data?: unknown }
  if (authorized.data === 'true' || authorized.data === true) return
  await device.tapOn({ text: 'Sign in', optional: true, timeout: 3000 })
  await device.tapOn({
    text: 'Use a password instead',
    optional: true,
    timeout: 3000
  })
  const available = (await device.evalBrowserScript({
    script: 'return document.body.innerText.includes("E-mail address")'
  })) as { data?: unknown }
  if (available.data === 'false' || available.data === false) return
  await device.tapOn({ text: 'E-mail address' })
  await device.inputText({ text: credentials.email })
  await device.tapOn({ text: 'Password' })
  await device.inputText({ text: credentials.password })
  await device.tapOn({ text: 'Sign in' })
  await device.assertVisible({ text: 'Follow a team', timeout: 60000 })
}

async function s1(daemon: Daemon): Promise<void> {
  const profile = required('CHAT_UI_PROFILE_DIR')
  const peerProfile = required('CHAT_UI_PEER_PROFILE_DIR')
  const conversationId = required('CHAT_UI_CONVERSATION')
  const messageId = required('CHAT_UI_MESSAGE')
  const browser =
    process.env.TS_CHROME_PATH ?? (await puppeteer.executablePath())
  const make = async (device: string, userDataDir: string): Promise<Device> =>
    await daemon.attach({
      device,
      platform: 'web',
      driver: 'cdp',
      url: WEB,
      artifacts: 'on-failure',
      extra: { browser, windowSize: '1440x1000', userDataDir }
    })
  const primary = await make('chat-ui-s1-primary', profile)
  const peer = await make('chat-ui-s1-peer', peerProfile)
  const preamble = `
    const api = ${JSON.stringify(API)};
    const id = ${JSON.stringify(conversationId)};
    const message = ${JSON.stringify(messageId)};
    async function request(method, path, body) {
      const response = await fetch(api + path, {method, credentials:'include', headers: body == null ? {} : {'Content-Type':'application/json'}, ...(body == null ? {} : {body: JSON.stringify(body)})});
      if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status);
      return await response.json();
    }
    function check(value, message) { if (!value) throw new Error(message); }
    const path = '/chat/conversations/' + encodeURIComponent(id);
  `
  try {
    await signIn(primary, 'Hc')
    await signIn(peer, 'Hs')
    await primary.openLink({ link: `${WEB}/chat` })
    await peer.openLink({ link: `${WEB}/chat` })
    console.log(
      '$ S1 PATCH personal preferences, GET list/pins, and compare public read cursors'
    )
    console.log(
      await primary.evalBrowserScript({
        script: `${preamble}
      const before = (await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(before != null, 'Fixture conversation missing');
      window.chatUiRestorePreferences = before.preferences;
      window.chatUiReadCursors = await request('GET', path + '/reads');
      const changed = await request('PATCH',path+'/preferences',{pinned:true,muted:true,manualUnread:true});
      const next = await request('PATCH',path+'/preferences',{manualUnread:true});
      check(next.manualUnreadRevision === changed.manualUnreadRevision + 1, 'Unread revision did not advance');
      await request('PUT',path+'/read',{seq:before.lastSeq,clearManualUnreadRevision:changed.manualUnreadRevision});
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed.preferences.pinned && listed.preferences.muted && listed.preferences.manualUnread, 'Personal state or stale-read protection missing');
      check(listed.lastPostAt === before.lastPostAt, 'Preferences changed recency');
      check(JSON.stringify(await request('GET',path+'/reads'))===JSON.stringify(window.chatUiReadCursors),'Mark unread changed public read cursors');
      const pins=await request('PUT',path+'/pins/'+encodeURIComponent(message));
      check(pins.some(pin=>pin.messageId===message),'Pin was not saved');
      await request('PUT',path+'/pins/'+encodeURIComponent(message));
      check((await request('GET',path+'/pins')).filter(pin=>pin.messageId===message).length===1,'Pin not idempotent');
      return {personalState:true,staleReadPreserved:true,publicReceiptsUnchanged:true,pinSavedOnce:true};
    `
      })
    )
    console.log('$ S1 GET another fixture user personal state and pins')
    console.log(
      await peer.evalBrowserScript({
        script: `${preamble}
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed != null && !listed.preferences.pinned && !listed.preferences.muted && !listed.preferences.manualUnread,'Another user received personal preferences');
      check(!(await request('GET',path+'/pins')).some(pin=>pin.messageId===message),'Another user received personal pin');
      const denied=await fetch(api+'/chat/conversations/not-a-fixture/pins',{credentials:'include'});
      check(denied.status===404,'Nonmember access not denied');
      return {otherUserIsolated:true,nonmemberDenied:true};
    `
      })
    )
    await primary.openTab({ url: `${WEB}/chat`, tabLabel: 'same-user-client' })
    console.log(
      '$ S1 GET personal state from another signed-in browser document'
    )
    console.log(
      await primary.evalBrowserScript({
        script: `${preamble}
      const listed=(await request('GET','/chat/conversations')).find(chat=>chat.id===id);
      check(listed.preferences.pinned && listed.preferences.muted && listed.preferences.manualUnread,'Same-user client did not reload personal state');
      check((await request('GET',path+'/pins')).some(pin=>pin.messageId===message),'Same-user client did not reload pins');
      await request('PUT',path+'/read',{seq:listed.lastSeq,clearManualUnreadRevision:listed.preferences.manualUnreadRevision});
      check(!(await request('GET','/chat/conversations')).find(chat=>chat.id===id).preferences.manualUnread,'Matching read did not clear unread');
      await request('DELETE',path+'/pins/'+encodeURIComponent(message));
      await request('DELETE',path+'/pins/'+encodeURIComponent(message));
      await request('PATCH',path+'/preferences',{pinned:false,muted:false,manualUnread:false});
      return {sameUserPersisted:true,matchingReadCleared:true,unpinIdempotent:true,fixturePresentationRestored:true};
    `
      })
    )
    console.log('S1 PASS')
  } finally {
    await primary.detach()
    await peer.detach()
  }
}

async function s2(daemon: Daemon): Promise<void> {
  const narrow = process.env.CHAT_UI_VIEWPORT === 'narrow'
  const m = await daemon.attach({
    device: narrow ? 'chat-ui-narrow' : 'chat-ui-wide',
    platform: 'web',
    driver: 'cdp',
    url: WEB,
    artifacts: 'on-failure',
    extra: {
      browser: process.env.TS_CHROME_PATH ?? (await puppeteer.executablePath()),
      windowSize: narrow ? '390x844' : '1440x1000',
      userDataDir: required('CHAT_UI_PROFILE_DIR')
    }
  })
  try {
    await signIn(m, narrow ? 'Hs' : 'Hc')
    await m.openLink({ link: WEB + '/chat' })
    if (process.env.CHAT_UI_INSPECT_KEYS === '1') {
      console.log(
        await m.evalBrowserScript({
          script: `
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ts-chat',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const read=key=>new Promise((resolve,reject)=>{const r=db.transaction('keys','readonly').objectStore('keys').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        const sealed=await read('record'),wrap=await read('wrap');
        let local={readable:false};
        if(sealed && wrap){try{const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:sealed.iv,additionalData:new TextEncoder().encode('ts-chat/v1/key-record')},wrap,sealed.ciphertext);const r=JSON.parse(new TextDecoder().decode(bytes));local={readable:true,userId:r.userId,deviceId:r.deviceId,hasIdentity:r.identity!=null,pukCount:r.puks?.length??0}}catch{}}
        db.close();const response=await fetch(${JSON.stringify(API + '/chat/me/keys')},{credentials:'include'});const remote=await response.json();
        return JSON.stringify({origin:location.origin,local,remote:{userId:remote.userId,deviceId:remote.deviceId,linked:remote.linked,hasIdentity:remote.identity!=null}});
      `
        })
      )
      return
    }
    await m.assertVisible({ text: 'Team Members', timeout: 60000 })
    console.log('$ S2 inspect scope pills and responsive pane visibility')
    console.log(
      await m.evalBrowserScript({
        script: `
      const list=document.querySelector('[data-testid="chat-list-pane"]');
      const messages=document.querySelector('[data-testid="chat-message-pane"]');
      if(!list || !messages)throw new Error('Workspace panes missing');
      if(getComputedStyle(list).display==='none')throw new Error('Chat list hidden');
      if(${narrow} && getComputedStyle(messages).display!=='none')throw new Error('Narrow message pane should be hidden on list route');
      if(!${narrow} && getComputedStyle(messages).display==='none')throw new Error('Wide message pane missing');
      if(!document.body.innerText.includes('Team Members') || !document.body.innerText.includes('Season All Staff'))throw new Error('Structured pills missing');
      return JSON.stringify({viewport:innerWidth,paneLayout:${narrow}?'narrow':'wide',scopePills:true});
    `
      })
    )
    const artifacts = required('CHAT_UI_ARTIFACTS')
    await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.assertVisible({
      text: 'Practice update: please bring water and arrive at 5:30.',
      timeout: 60000
    })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Mark unread' })
    await m.assertVisible({ text: 'Mute' })
    await m.assertVisible({ text: 'Pin' })
    writeFileSync(
      join(
        artifacts,
        narrow
          ? 'narrow-conversation-menu-after.png'
          : 'wide-conversation-menu-after.png'
      ),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Pin' })
    if (narrow) await m.tapOn({ text: 'Back' })
    await m.assertVisible({ text: 'Pinned', timeout: 30000 })
    writeFileSync(
      join(
        artifacts,
        narrow ? 'narrow-chat-list-after.png' : 'wide-chat-list-after.png'
      ),
      await m.screenshot()
    )
    if (narrow)
      await m.tapOn({ css: '[role="button"][aria-label="Hawks Members"]' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Unpin' })
    await m.tapOn({ text: 'Unpin' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.tapOn({ text: 'Mute' })
    await m.assertVisible({ text: 'Muted', timeout: 30000 })
    await m.tapOn({ text: 'Conversation actions' })
    await m.assertVisible({ text: 'Unmute' })
    await m.tapOn({ text: 'Unmute' })
    await m.tapOn({ text: 'Conversation actions' })
    await m.tapOn({ text: 'Mark unread' })
    console.log('$ S3 manual unread survives the mounted selected pane')
    console.log(
      await m.evalBrowserScript({
        script: `
      await new Promise(resolve=>setTimeout(resolve,1000));
      const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});
      const chat=(await response.json()).find(item=>item.id===${JSON.stringify(required('CHAT_UI_CONVERSATION'))});
      if(!chat.preferences.manualUnread)throw new Error('Selected pane immediately cleared Mark unread');
      return JSON.stringify({manualUnreadOnOpenPane:true,mutingAndPinning:true});
    `
      })
    )
    await m.tapOn({ css: '[data-testid="chat-composer"]' })
    console.log(
      await m.evalBrowserScript({
        script: `
      await new Promise(resolve=>setTimeout(resolve,500));
      const response=await fetch(${JSON.stringify(API + '/chat/conversations')},{credentials:'include'});
      const chat=(await response.json()).find(item=>item.id===${JSON.stringify(required('CHAT_UI_CONVERSATION'))});
      if(chat.preferences.manualUnread)throw new Error('Explicit composer read did not clear manual unread');
      return JSON.stringify({explicitReadCleared:true});
    `
      })
    )
    console.log(narrow ? 'S2/S3 narrow PASS' : 'S2/S3 wide PASS')
  } finally {
    await m.detach()
  }
}

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(
    scenario === 'S1' || scenario === 'S2',
    'Name a supported follow-up scenario'
  )
  const root = required('MAESTRO_D_CLIENT_ROOT')
  const load = createRequire(join(resolve(root), 'package.json'))
  const { MaestroD } = load('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: required('MAESTRO_D_BIN')
  })
  try {
    if (scenario === 'S1') await s1(daemon)
    else await s2(daemon)
  } finally {
    await daemon.close()
  }
}
main().catch((error: unknown) => {
  let message = String((error as { message?: string }).message ?? error)
  for (const secret of hidden)
    message = message.split(secret).join('[withheld]')
  console.error(message)
  process.exitCode = 1
})
