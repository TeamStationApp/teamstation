import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import * as nodemailer from 'nodemailer'

import type { SmtpSettings } from '../serverConfig'
import {
  guardianInviteSender,
  sendGuardianInvitation,
  sendInvitation
} from './sendMail'

const smtp: SmtpSettings = {
  host: 'mail.example.com',
  port: 587,
  secure: false,
  user: '',
  password: '',
  fromAddress: 'mail@example.com',
  fromName: 'TeamStation'
}
const invitation = {
  playerName: 'Ben C',
  teamName: 'Demo Hawks',
  invitedBy: 'Ichiro',
  link: 'https://example.com/notifications/inv_one'
}

/** Names a sender types, each with every character HTML gives a meaning. */
const marked = {
  playerName: `Bo <b>"Kid"</b> & 'Co'`,
  teamName: `<a href="https://evil.example/">Hawks</a> & 'Co'`,
  invitedBy: `<img src="x"> "Coach" & 'Co'`,
  link: 'https://example.com/notifications/inv_one?a=1&b="2"'
}

describe('the guardian invitation mail', () => {
  const sent: Array<Record<string, string>> = []
  // The module's own exports, which `sendMail.ts` reads each time it builds.
  const relay = nodemailer as unknown as Record<string, unknown>
  const createTransport = relay.createTransport
  before(() => {
    // The relay is the one thing not run here: whatever reaches it is kept.
    // `sendMail.ts` keeps the first transport it makes, so this one stays for
    // the rest of the run; no other suite sends through a relay.
    relay.createTransport = () => ({
      sendMail: async (message: Record<string, string>) => {
        sent.push(message)
        return { accepted: [message.to], messageId: 'fixture-message' }
      }
    })
  })
  after(() => {
    relay.createTransport = createTransport
  })

  it('names the player, the team and who asked, and links to the notification', async () => {
    expect(
      await sendGuardianInvitation(smtp, 'parent@example.com', invitation)
    ).deep.equals({ accepted: 1, messageId: 'fixture-message' })
    const mail = sent.at(-1)!
    expect(mail.from).equals('TeamStation <mail@example.com>')
    expect(mail.to).equals('parent@example.com')
    expect(mail.subject).equals("Be Ben C's guardian on TeamStation")
    expect(mail.text).equals(
      "Ichiro from Demo Hawks invited you to be Ben C's guardian on TeamStation. Sign in to accept.\n\nhttps://example.com/notifications/inv_one"
    )
    expect(mail.html).contains('https://example.com/notifications/inv_one')
    expect(mail.html).contains('Accept the invitation')
  })

  it('names only who asked when a guardian of the player sent it, escaped in the HTML', async () => {
    const { teamName: _team, ...byGuardian } = marked
    await sendGuardianInvitation(smtp, 'parent@example.com', byGuardian)
    const mail = sent.at(-1)!
    expect(mail.text).equals(
      `<img src="x"> "Coach" & 'Co' invited you to be Bo <b>"Kid"</b> & 'Co''s guardian on TeamStation. Sign in to accept.\n\nhttps://example.com/notifications/inv_one?a=1&b="2"`
    )
    expect(mail.html).contains(
      '<p><strong>&lt;img src=&quot;x&quot;&gt; &quot;Coach&quot; &amp; &#39;Co&#39;</strong>\ninvited you to be <strong>Bo &lt;b&gt;&quot;Kid&quot;&lt;/b&gt; &amp; &#39;Co&#39;</strong>'
    )
    expect(mail.html).not.contains(' from ')
    expect(mail.html).not.contains('<img')
  })

  it('is sent through the relay when one is set up, and only logged when not', async () => {
    const lines: string[] = []
    const logger = { log: (line: string) => lines.push(line) }
    await guardianInviteSender(smtp, logger)('parent@example.com', invitation)
    expect(sent.at(-1)!.to).equals('parent@example.com')
    await guardianInviteSender({ ...smtp, host: '', fromName: '' }, logger)(
      'other@example.com',
      invitation
    )
    expect(sent.map(mail => mail.to)).not.includes('other@example.com')
    expect(lines).deep.equals([
      'guardian invitation sent to parent@example.com: 1 accepted, id fixture-message',
      '[no mail configured] guardian invitation for other@example.com: https://example.com/notifications/inv_one'
    ])
  })

  it('prints every name and the link as text in the HTML, and as typed in the plain text', async () => {
    await sendGuardianInvitation(smtp, 'parent@example.com', marked)
    const mail = sent.at(-1)!
    expect(mail.subject).equals(
      `Be Bo <b>"Kid"</b> & 'Co''s guardian on TeamStation`
    )
    expect(mail.text).equals(
      `<img src="x"> "Coach" & 'Co' from <a href="https://evil.example/">Hawks</a> & 'Co' invited you to be Bo <b>"Kid"</b> & 'Co''s guardian on TeamStation. Sign in to accept.\n\nhttps://example.com/notifications/inv_one?a=1&b="2"`
    )
    expect(mail.html).contains(
      '<strong>&lt;img src=&quot;x&quot;&gt; &quot;Coach&quot; &amp; &#39;Co&#39;</strong>'
    )
    expect(mail.html).contains(
      '<strong>&lt;a href=&quot;https://evil.example/&quot;&gt;Hawks&lt;/a&gt; &amp; &#39;Co&#39;</strong>'
    )
    expect(mail.html).contains(
      '<strong>Bo &lt;b&gt;&quot;Kid&quot;&lt;/b&gt; &amp; &#39;Co&#39;</strong>'
    )
    expect(mail.html).contains(
      'href="https://example.com/notifications/inv_one?a=1&amp;b=&quot;2&quot;"'
    )
    expect(mail.html).not.contains('<img')
    expect(mail.html).not.contains('<b>')
    expect(mail.html).not.contains('evil.example/"')
  })

  it('prints the names in a watch invitation as text too', async () => {
    await sendInvitation(smtp, 'fan@example.com', {
      scopeName: marked.teamName,
      invitedBy: marked.invitedBy,
      link: marked.link
    })
    const mail = sent.at(-1)!
    expect(mail.subject).equals(
      `<img src="x"> "Coach" & 'Co' has invited you to watch <a href="https://evil.example/">Hawks</a> & 'Co'`
    )
    expect(mail.text).contains(
      `<img src="x"> "Coach" & 'Co' has invited you to watch <a href="https://evil.example/">Hawks</a> & 'Co' on TeamStation.`
    )
    expect(mail.html).contains(
      '<p><strong>&lt;img src=&quot;x&quot;&gt; &quot;Coach&quot; &amp; &#39;Co&#39;</strong> has invited you to watch'
    )
    expect(mail.html).contains(
      '<strong>&lt;a href=&quot;https://evil.example/&quot;&gt;Hawks&lt;/a&gt; &amp; &#39;Co&#39;</strong> on TeamStation.</p>'
    )
    expect(mail.html).contains(
      'Or paste this address: https://example.com/notifications/inv_one?a=1&amp;b=&quot;2&quot;'
    )
    expect(mail.html).not.contains('<img')
    expect(mail.html).not.contains('<a href="https://evil')
  })
})
