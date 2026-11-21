import { mailConfigured, sendSignInCode } from '../email/sendMail'
import type { SmtpSettings } from '../serverConfig'

/**
 * The account route's sender: it refuses when mail is not configured, because a person
 * is waiting on this code, and otherwise delivers and logs like every other code.
 */
export function accountCodeSender(
  smtp: SmtpSettings,
  options: Parameters<typeof deliverSignInCode>[4] = {}
): (email: string, code: string) => Promise<void> {
  return async (email, code) => {
    if (!mailConfigured(smtp)) throw new Error('Email is not configured')
    await deliverSignInCode(smtp, email, code, undefined, options)
  }
}

/** The production adapter preserves delivery failures for the auth endpoint. */
export async function deliverSignInCode(
  smtp: SmtpSettings,
  email: string,
  code: string,
  link?: string,
  options: {
    send?: typeof sendSignInCode
    logger?: Pick<Console, 'log' | 'error'>
  } = {}
): Promise<void> {
  const logger = options.logger ?? console
  if (!mailConfigured(smtp)) {
    logger.log(
      `[no mail configured] sign-in code for ${email}: ${code}` +
        (link == null ? '' : `\n[no mail configured] link: ${link}`)
    )
    return
  }
  try {
    const sent = await (options.send ?? sendSignInCode)(smtp, email, code, link)
    logger.log(
      `sign-in code sent to ${email}: ${sent.accepted} accepted, id ${sent.messageId}`
    )
  } catch (error) {
    logger.error(`FAILED to send a sign-in code to ${email}: ${String(error)}`)
    throw new Error('The sign-in email could not be delivered', {
      cause: error
    })
  }
}
