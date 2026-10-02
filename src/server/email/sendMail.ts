import { createTransport, type Transporter } from 'nodemailer'

import type { SmtpSettings } from '../serverConfig'

/**
 * Sending mail.
 *
 * There is exactly one thing to send today — a sign-in code — and it has to
 * arrive, because 34 of the 60 migrated accounts have no password and a code
 * is their only way in.
 *
 * The relay is the one PeerTube already uses on this host, so the domain's
 * SPF and DKIM already vouch for it. A second provider would mean a second
 * set of DNS records to get right before anything landed in an inbox.
 */

let transport: Transporter | undefined

export function mailConfigured(smtp: SmtpSettings): boolean {
  return smtp.host !== '' && smtp.fromAddress !== ''
}

function transporterFor(smtp: SmtpSettings): Transporter {
  if (transport != null) return transport
  transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    // Brevo's relay on 2525 starts in the clear and upgrades with STARTTLS,
    // which is what `secure: false` plus `requireTLS` asks for. It is not
    // "no encryption": refusing the upgrade fails the send.
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth:
      smtp.user === '' ? undefined : { user: smtp.user, pass: smtp.password },
    // A sign-in code is worthless late; failing fast lets the caller say so.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  })
  return transport
}

export interface SentMail {
  accepted: number
  messageId: string
}

export async function sendSignInCode(
  smtp: SmtpSettings,
  to: string,
  code: string,
  /** The one-tap link, when there is somewhere for it to land. */
  link?: string
): Promise<SentMail> {
  const info = await transporterFor(smtp).sendMail({
    from:
      smtp.fromName === ''
        ? smtp.fromAddress
        : `${smtp.fromName} <${smtp.fromAddress}>`,
    to,
    subject: `${code} is your TeamStation sign-in code`,
    // The code is in the subject as well as the body: on a phone that is
    // often all somebody needs to see, without opening anything.
    text: [
      ...(link == null
        ? []
        : ['Tap to sign in:', link, '', 'Or type the code instead.', '']),
      `Your TeamStation sign-in code is ${code}.`,
      '',
      'It is good for the next 15 minutes and can be used once.',
      '',
      'If you did not ask to sign in, you can ignore this — somebody typed',
      'your address by mistake, and without the code nothing happens.'
    ].join('\n'),
    html: [
      ...(link == null ? [] : [signInButton(link)]),
      '<p>Or use this code:</p>',
      `<p style="font-size:28px;letter-spacing:4px;font-family:monospace"><strong>${code}</strong></p>`,
      '<p>It is good for the next 15 minutes and can be used once.</p>',
      '<p style="color:#666">If you did not ask to sign in, you can ignore this —',
      'somebody typed your address by mistake, and without the code nothing happens.</p>'
    ].join('\n')
  })

  return {
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    messageId: String(info.messageId ?? '')
  }
}

/**
 * An invitation, addressed to one person by an administrator.
 *
 * Says who invited them and to what, because an unexplained link asking for
 * an e-mail address is exactly what a parent has been told to ignore. The
 * address is printed as text under the button for the clients that eat
 * buttons, the same as the sign-in mail.
 */
export async function sendInvitation(
  smtp: SmtpSettings,
  to: string,
  invitation: { scopeName: string; invitedBy: string; link: string }
): Promise<SentMail> {
  const { scopeName, invitedBy, link } = invitation
  const info = await transporterFor(smtp).sendMail({
    from:
      smtp.fromName === ''
        ? smtp.fromAddress
        : `${smtp.fromName} <${smtp.fromAddress}>`,
    to,
    subject: `${invitedBy} has invited you to watch ${scopeName}`,
    text: [
      `${invitedBy} has invited you to watch ${scopeName} on TeamStation.`,
      '',
      'Open this to accept:',
      link,
      '',
      'You will be asked for your name and e-mail address, and sent a code',
      'to prove the address is yours. Nothing happens until you do.'
    ].join('\n'),
    html: [
      `<p><strong>${invitedBy}</strong> has invited you to watch`,
      `<strong>${scopeName}</strong> on TeamStation.</p>`,
      inviteButton(link),
      '<p style="color:#666">You will be asked for your name and e-mail',
      'address, and sent a code to prove the address is yours.</p>'
    ].join('\n')
  })
  return {
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    messageId: String(info.messageId ?? '')
  }
}

/**
 * The green button, in the markup that survives a mail client.
 *
 * A table and a background colour on the cell, not a styled `<a>`: Outlook
 * drops padding and background from an anchor and leaves a bare blue link. The
 * address is printed underneath as text as well, because some clients eat
 * buttons and a sign-in that cannot be reached is worse than an ugly one.
 */
function signInButton(link: string): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td align="center" bgcolor="#334423" style="border-radius:8px">',
    `<a href="${link}" style="display:inline-block;padding:14px 28px;`,
    'font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;',
    'color:#ffffff;text-decoration:none">Sign in to TeamStation</a>',
    '</td></tr></table>',
    `<p style="color:#666;font-size:12px">Or paste this address: ${link}</p>`
  ].join('')
}

/** Proves the relay will take a message, without sending one. */
export async function verifyMail(smtp: SmtpSettings): Promise<boolean> {
  return await transporterFor(smtp).verify()
}

/** The same button, worded for an invitation rather than a sign-in. */
function inviteButton(link: string): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td align="center" bgcolor="#334423" style="border-radius:8px">',
    `<a href="${link}" style="display:inline-block;padding:14px 28px;`,
    'font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;',
    'color:#ffffff;text-decoration:none">Accept the invitation</a>',
    '</td></tr></table>',
    `<p style="color:#666;font-size:12px">Or paste this address: ${link}</p>`
  ].join('')
}
