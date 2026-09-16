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
  code: string
): Promise<SentMail> {
  const info = await transporterFor(smtp).sendMail({
    from:
      smtp.fromName === ''
        ? smtp.fromAddress
        : `${smtp.fromName} <${smtp.fromAddress}>`,
    to,
    subject: `${code} is your GameStation sign-in code`,
    // The code is in the subject as well as the body: on a phone that is
    // often all somebody needs to see, without opening anything.
    text: [
      `Your GameStation sign-in code is ${code}.`,
      '',
      'It is good for the next 15 minutes and can be used once.',
      '',
      'If you did not ask to sign in, you can ignore this — somebody typed',
      'your address by mistake, and without the code nothing happens.'
    ].join('\n'),
    html: [
      '<p>Your GameStation sign-in code is:</p>',
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

/** Proves the relay will take a message, without sending one. */
export async function verifyMail(smtp: SmtpSettings): Promise<boolean> {
  return await transporterFor(smtp).verify()
}
