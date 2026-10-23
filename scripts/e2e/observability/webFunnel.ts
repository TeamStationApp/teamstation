import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Values are never returned to the driver report or its inputText log. */
async function fill(m: any, values: Record<string, string>): Promise<void> {
  const result = await m.evalBrowserScript({
    script: `const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [label,value] of Object.entries(${JSON.stringify(values)})){const input=document.querySelector('input[aria-label="'+label+'"]');if(!input)return 'missing';set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}return 'filled';`
  })
  assert.equal(result.data, 'filled')
}

async function click(m: any, label: string): Promise<void> {
  const result = await m.evalBrowserScript({
    script: `const button=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return 'missing';button.click();return 'clicked';`
  })
  assert.equal(result.data, 'clicked')
}

export async function webFunnel(
  m: any,
  origin: string,
  fixtures: any
): Promise<void> {
  const started = new Date().toISOString()
  const email = 'observability-signup-' + Date.now() + '@example.test'
  assert(
    fixtures.creatorTeamId != null && fixtures.joinTeam != null,
    'Owned discovery fixtures required'
  )
  await m.openLink({
    link: origin + '/groups/team/' + fixtures.creatorTeamId + '/create-game'
  })
  await m.tapOn({ text: '^Practice$', timeout: 5000 })
  await click(m, 'Create event')
  await pause(1000)
  await m.openLink({ link: origin + '/account' })
  await click(m, 'Sign out')
  await m.assertVisible({ text: 'E-mail address' })
  await fill(m, { 'E-mail address': email })
  await click(m, 'Send me a sign-in code')
  await m.assertVisible({ text: 'Sign-in code', timeout: 15000 })
  const { stdout } = await promisify(execFile)(
    process.env.OBSERVABILITY_MAIL_READER!,
    [],
    {
      env: { ...process.env, OBSERVABILITY_MAIL_ADDRESS: email },
      timeout: 30000
    }
  )
  const code = stdout.trim()
  assert(/^\d{6}$/.test(code), 'Fixture mail must supply a sign-in code')
  await fill(m, { 'Sign-in code': code })
  await click(m, 'Sign in')
  await m.assertVisible({ text: 'What is your name?' })
  await fill(m, { Name: 'Observability signup' })
  await click(m, 'Continue')
  await m.assertVisible({ text: 'Choose your photo' })
  await click(m, 'Use my initials')
  await m.assertVisible({
    text: 'Account, Observability signup',
    timeout: 15000
  })
  const actor = await m.evalBrowserScript({
    script:
      "const r=await fetch('/api/v1/auth/me');const body=await r.json();return body.user?.id??body.id;"
  })
  assert(typeof actor.data === 'string' && actor.data !== '')
  await m.openLink({ link: origin + '/discover' })
  await click(m, 'Teams')
  await fill(m, { 'Search by name or city': fixtures.joinTeam.name })
  await m.assertVisible({ text: fixtures.joinTeam.name, timeout: 15000 })
  const opened = await m.evalBrowserScript({
    script: `const e=[...document.querySelectorAll('a,button')].find(n=>n.textContent.includes(${JSON.stringify(fixtures.joinTeam.name)}));if(!e)return 'missing';e.click();return 'opened';`
  })
  assert.equal(opened.data, 'opened')
  await m.assertVisible({ text: 'Follow ' + fixtures.joinTeam.name })
  await click(m, 'Follow')
  await m.assertVisible({ text: 'Unfollow ' + fixtures.joinTeam.name })
  // A live invite is a credential; openLink's report prints URLs. Evaluation reports only a fixed label.
  await m.evalBrowserScript({
    script: `setTimeout(()=>window.location.assign(${JSON.stringify(origin + '/i/' + fixtures.joinTeam.code)}),50);return 'opening invitation';`
  })
  await pause(1000)
  await m.assertVisible({ text: 'Accept the invitation', timeout: 15000 })
  await click(m, 'Accept the invitation')
  await m.assertVisible({ text: 'Have a look', timeout: 15000 })
  await click(m, 'Have a look')
  await m.pressKey({ key: 'BACK' })
  await m.openLink({ link: origin + '/account' })
  await click(m, 'Sign out')
  await m.assertVisible({ text: 'E-mail address' })
  const second = fixtures.accounts.find(
    (account: any) => account.role === 'second'
  )
  await click(m, 'Use a password instead')
  await fill(m, { 'E-mail address': second.email, Password: second.password })
  await click(m, 'Sign in')
  await m.assertVisible({
    text: 'Account, Observability second',
    timeout: 15000
  })
  await pause(5500)
  const admin = fixtures.accounts.find(
    (account: any) => account.role === 'admin'
  )
  const response = await fetch(origin + '/api/v1/admin/analytics/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + admin.token
    },
    body: JSON.stringify({
      sql: 'SELECT event_name, properties, user_id, session_id FROM analytics.events WHERE occurred_at >= $1 AND app = $2 ORDER BY occurred_at',
      parameters: [started, 'TS web']
    })
  })
  assert.equal(response.status, 200)
  const rows: any[] = (await response.json()).rows
  for (const event of [
    'signup_started',
    'signup_step_completed',
    'account_created',
    'onboarding_completed',
    'page_viewed',
    'search_submitted',
    'follow_changed',
    'join_requested',
    'invite_accepted',
    'event_created',
    'logout',
    'login_succeeded'
  ]) {
    assert(
      rows.some((row: any) => row.event_name === event),
      'Missing ' + event
    )
  }
  assert(
    rows.some(
      (row: any) =>
        row.event_name === 'account_created' && row.user_id === actor.data
    )
  )
  assert(
    rows.some(
      (row: any) =>
        row.event_name === 'login_succeeded' && row.user_id === second.id
    )
  )
  const serialized = JSON.stringify(rows)
  for (const secret of [
    email,
    code,
    second.email,
    second.password,
    fixtures.joinTeam.code,
    'Observability signup'
  ])
    assert(!serialized.includes(secret), 'Private form value reached analytics')
  console.log(
    'web: TLS fixture mail, real signup/onboarding, navigation, search/follow/invitation/event creation, logout and second-account login; correct actors and no form values'
  )
}
