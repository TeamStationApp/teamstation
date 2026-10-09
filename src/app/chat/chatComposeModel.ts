import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS,
  MAX_BODY
} from '../../common/chatContent'
import { lstrings, sprintf } from '../locales/strings'
import type { PickedFile } from './chatFileTypes'

/** Validate metadata before either picker or drop reads file bytes. */
export function attachmentProblem(
  files: Array<{ fileName: string; size: number }>,
  remaining = MAX_ATTACHMENTS
): string | undefined {
  if (files.length > remaining) return lstrings.chat_attachment_limit
  const large = files.find(file => file.size > MAX_ATTACHMENT_SIZE)
  return large == null
    ? undefined
    : sprintf(lstrings.chat_too_large, large.fileName)
}

/** Every send entry uses the same current state and encrypted-content limits. */
export function sendAllowed(state: {
  enabled: boolean
  sending: boolean
  preparing: boolean
  text: string
  attachments: PickedFile[]
}): boolean {
  const body = state.text.trim()
  return (
    state.enabled &&
    !state.sending &&
    !state.preparing &&
    (body !== '' || state.attachments.length > 0) &&
    Array.from(body).length <= MAX_BODY &&
    attachmentProblem(
      state.attachments.map(file => ({
        fileName: file.fileName,
        size: file.bytes.length
      }))
    ) == null
  )
}
