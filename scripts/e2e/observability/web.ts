import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { webFunnel } from './webFunnel'
import { webVideo } from './webVideo'

/** Browser execution returns only status codes or fixed labels, never credentials. */
export async function webScenario(
  m: any,
  scenario: string,
  origin: string,
  collector: string
): Promise<void> {
  await m.openLink({ link: origin + '/sign-in' })
  if (scenario === 'cors') {
    const project = process.env.OBSERVABILITY_LOG_PROJECT
    assert(
      project != null && /^[0-9]+$/.test(project),
      'Set OBSERVABILITY_LOG_PROJECT'
    )
    const id = randomUUID()
    const row = {
      D: new Date().toISOString(),
      A: 'TS web',
      I: id,
      E: 'app_error',
      L: 'error',
      R: 1,
      P: { ec: 'internal' }
    }
    const result = await m.evalBrowserScript({
      script: `
      const response = await fetch(${JSON.stringify(collector + '/ingest/' + project)}, {
        method:'POST', headers:{'content-type':'application/x-ndjson'},
        body:${JSON.stringify(JSON.stringify(row) + '\n')}, credentials:'omit'
      }); return String(response.status);`
    })
    assert.equal(result.data, '202')
    const event = {
      event_id: randomUUID().replaceAll('-', ''),
      timestamp: new Date().toISOString(),
      level: 'error',
      release: 'app.example@1.0.0',
      exception: { values: [{ type: 'Error', value: 'private-canary' }] }
    }
    const envelope =
      JSON.stringify({}) +
      '\n' +
      JSON.stringify({ type: 'event' }) +
      '\n' +
      JSON.stringify(event) +
      '\n'
    const accepted = await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(collector + '/api/' + project + '/envelope')}, {method:'POST', headers:{'content-type':'application/x-sentry-envelope'},body:${JSON.stringify(envelope)},credentials:'omit'}); return String(r.status);`
    })
    assert.equal(accepted.data, '200')
    const malformed = await m.evalBrowserScript({
      script: `const r=await fetch(${JSON.stringify(collector + '/ingest/' + project)}, {method:'POST',headers:{'content-type':'application/x-ndjson'},body:'invalid',credentials:'omit'});return String(r.status);`
    })
    assert.equal(malformed.data, '400')
    await m.openLink({ link: 'data:text/html,<title>Unlisted origin</title>' })
    const denied = await m.evalBrowserScript({
      script: `try {await fetch(${JSON.stringify(collector + '/ingest/' + project)},{method:'POST',headers:{'content-type':'application/x-ndjson'},body:'{}',credentials:'omit'});return 'unexpected';}catch{return 'blocked';}`
    })
    assert.equal(denied.data, 'blocked')
    await m.openLink({ link: origin + '/sign-in' })
    console.log(
      'web: browser preflight, JSONL and SDK envelope intake, readable validation errors, and unlisted-origin refusal PASS'
    )
    return
  }
  assert(['errors', 'video', 'funnel'].includes(scenario))
  const fixtures = JSON.parse(
    await readFile(process.env.OBSERVABILITY_FIXTURES!, 'utf8')
  )
  const account = fixtures.accounts.find((a: any) => a.role === 'admin')
  // The driver logs inputText verbatim. Browser evaluation has a fixed report
  // label and no script parameters in its report; never return the filled value.
  const signedIn = await m.evalBrowserScript({
    script: `const r=await fetch('/api/v1/auth/me');if(!r.ok)return 'anonymous';const body=await r.json();return (body.user?.id??body.id)===${JSON.stringify(account.id)}?'admin':'other';`
  })
  if (signedIn.data === 'other') {
    await m.openLink({ link: origin + '/account' })
    await m.tapOn({ text: 'Sign out' })
    await m.assertVisible({ text: 'E-mail address' })
  }
  if (signedIn.data !== 'admin') {
    await m.tapOn({ text: 'Use a password instead', optional: true })
    const values = {
      'E-mail address': account.email,
      Password: account.password
    }
    const filled = await m.evalBrowserScript({
      script: `try {const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [label,value] of Object.entries(${JSON.stringify(values)})){const input=document.querySelector('input[aria-label="'+label+'"]');if(!input)return 'missing';set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}return 'filled';}catch{return 'failed';}`
    })
    assert.equal(filled.data, 'filled')
    await m.evalBrowserScript({
      script:
        "const button=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Sign in');if(!button)throw Error('Sign-in button missing');button.click();return 'submitted';"
    })
    await m.assertVisible({
      text: 'Account, Observability admin',
      timeout: 15000
    })
  }
  if (scenario === 'video') {
    await webVideo(m, origin, fixtures)
    return
  }
  if (scenario === 'funnel') {
    await webFunnel(m, origin, fixtures)
    return
  }
  await m.tapOn({ text: 'About TeamStation' })
  const clicked = await m.evalBrowserScript({
    script:
      "const button=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Send a test error');if(!button)return 'missing';button.click();return 'clicked';"
  })
  assert.equal(clicked.data, 'clicked')
  console.log('web: invoked the shipped administrator test-error action')
}
