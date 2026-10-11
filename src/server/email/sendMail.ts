import { createTransport, type Transporter } from 'nodemailer'

import type { SmtpSettings } from '../serverConfig'

/**
 * Sending mail.
 *
 * There is exactly one thing to send today — a sign-in code — and it has to
 * arrive, because many migrated accounts have no password and a code is
 * their only way in.
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
    // A relay on a submission port that starts in the clear and upgrades with STARTTLS
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
      `<p><strong>${escapeHtml(invitedBy)}</strong> has invited you to watch`,
      `<strong>${escapeHtml(scopeName)}</strong> on TeamStation.</p>`,
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

/** What a guardian invitation says, and where it opens. */
export interface GuardianInvitation {
  /** The player's short name: first name and last initial. */
  playerName: string
  /** The team that sent it; absent when one of the player's guardians did. */
  teamName?: string
  invitedBy: string
  /** The notification, which is where it is accepted. */
  link: string
}

/**
 * An invitation to be a player's guardian, from a team's administrator,
 * coach or assistant, or from one of the player's guardians.
 *
 * The link opens the notification, which is where it is accepted, after
 * signing in with this address. The player is named the way the app names
 * everybody: first name and last initial.
 */
export async function sendGuardianInvitation(
  smtp: SmtpSettings,
  to: string,
  invitation: GuardianInvitation
): Promise<SentMail> {
  const { playerName, teamName, invitedBy, link } = invitation
  const info = await transporterFor(smtp).sendMail({
    from:
      smtp.fromName === ''
        ? smtp.fromAddress
        : `${smtp.fromName} <${smtp.fromAddress}>`,
    to,
    subject: `Be ${playerName}'s guardian on TeamStation`,
    text: [
      `${invitedBy}${teamName == null ? '' : ` from ${teamName}`} invited you to be ${playerName}'s guardian on TeamStation. Sign in to accept.`,
      '',
      link
    ].join('\n'),
    html: [
      `<p><strong>${escapeHtml(invitedBy)}</strong>${teamName == null ? '' : ` from <strong>${escapeHtml(teamName)}</strong>`}`,
      `invited you to be <strong>${escapeHtml(playerName)}</strong>'s guardian on`,
      'TeamStation. Sign in to accept.</p>',
      inviteButton(link)
    ].join('\n')
  })
  return {
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    messageId: String(info.messageId ?? '')
  }
}

/**
 * `sendGuardianInvitation` as the routes call it: only logged when no relay
 * is set up, and thrown on failure, like every invitation, because whoever
 * typed the address is waiting to hear whether it went.
 */
export function guardianInviteSender(
  smtp: SmtpSettings,
  logger: Pick<Console, 'log'> = console
): (email: string, invitation: GuardianInvitation) => Promise<void> {
  return async (email, invitation) => {
    if (!mailConfigured(smtp)) {
      logger.log(
        `[no mail configured] guardian invitation for ${email}: ${invitation.link}`
      )
      return
    }
    const sent = await sendGuardianInvitation(smtp, email, invitation)
    logger.log(
      `guardian invitation sent to ${email}: ${sent.accepted} accepted, id ${sent.messageId}`
    )
  }
}

/** What the mail saying somebody was added to a group says. */
export interface AddedNotice {
  /** Who added them. */
  addedBy: string
  /** The team, season or league. */
  scopeName: string
  /** "Coach and Scorekeeper", or empty for a membership alone. */
  roles: string
  /** The notification, where they can leave again. */
  link: string
}

/**
 * Tells somebody they were added to a team, season or league, as a person
 * with an account is now, with no invitation to accept: who did it, as what,
 * and a link to the notification, which is where they can leave.
 */
export async function sendAddedNotice(
  smtp: SmtpSettings,
  to: string,
  notice: AddedNotice
): Promise<SentMail> {
  const { addedBy, scopeName, roles, link } = notice
  const what = roles === '' ? `to ${scopeName}` : `as ${roles} of ${scopeName}`
  const info = await transporterFor(smtp).sendMail({
    from:
      smtp.fromName === ''
        ? smtp.fromAddress
        : `${smtp.fromName} <${smtp.fromAddress}>`,
    to,
    subject: `${addedBy} added you ${what} on TeamStation`,
    text: [
      `${addedBy} added you ${what} on TeamStation.`,
      '',
      'Nothing to accept. If you don’t want to be in it, you can leave it here:',
      link
    ].join('\n'),
    html: [
      `<p><strong>${escapeHtml(addedBy)}</strong> added you`,
      roles === ''
        ? `to <strong>${escapeHtml(scopeName)}</strong>`
        : `as ${escapeHtml(roles)} of <strong>${escapeHtml(scopeName)}</strong>`,
      'on TeamStation.</p>',
      '<p>Nothing to accept. If you don’t want to be in it, you can leave it from the notification.</p>',
      linkButton(link, 'Open the notification')
    ].join('\n')
  })
  return {
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    messageId: String(info.messageId ?? '')
  }
}

/**
 * `sendAddedNotice` as the routes call it: logged when no relay is set up,
 * and thrown on failure, so the add that wanted it is not left half done.
 */
export function addedNoticeSender(
  smtp: SmtpSettings,
  logger: Pick<Console, 'log'> = console
): (email: string, notice: AddedNotice) => Promise<void> {
  return async (email, notice) => {
    if (!mailConfigured(smtp)) {
      logger.log(
        `[no mail configured] added notice for ${email}: ${notice.link}`
      )
      return
    }
    const sent = await sendAddedNotice(smtp, email, notice)
    logger.log(
      `added notice sent to ${email}: ${sent.accepted} accepted, id ${sent.messageId}`
    )
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
  return linkButton(link, 'Accept the invitation')
}

/** The same button, with its own words. */
function linkButton(link: string, label: string): string {
  const href = escapeHtml(link)
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td align="center" bgcolor="#334423" style="border-radius:8px">',
    `<a href="${href}" style="display:inline-block;padding:14px 28px;`,
    'font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;',
    `color:#ffffff;text-decoration:none">${escapeHtml(label)}</a>`,
    '</td></tr></table>',
    `<p style="color:#666;font-size:12px">Or paste this address: ${href}</p>`
  ].join('')
}

/**
 * Text as HTML. Names in an invitation are typed by whoever sent it, so
 * they are printed as text, never read as markup or a link of their own.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
