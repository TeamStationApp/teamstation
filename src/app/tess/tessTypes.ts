/**
 * Tess's shapes as the chat sees them: the conversation the server keeps for
 * the signed-in user, and the calls that read and change it. They are the
 * API client's own; this module names the parts the chat uses.
 *
 * Tool calls and tool results never reach the client. An assistant message
 * carries the changes it proposed, each as the server stored it, so the card
 * shows what will run rather than what the model said about it.
 */
import type {
  TeamStationClient,
  TessAttachmentBody,
  TessChange,
  TessMessage
} from '../../common/api'

export type {
  TessChange,
  TessConversation,
  TessMessage,
  TessScreen,
  TessUsageWeek
} from '../../common/api'

export type TessAttachmentRef = TessMessage['attachments'][number]
export type TessAttachmentKind = TessAttachmentRef['kind']
export type TessChangeStatus = TessChange['status']

/** A file on its way to the server: its bytes are base64. */
export type TessUpload = TessAttachmentBody

/** The part of `TeamStationClient` the chat calls. */
export type TessApi = Pick<
  TeamStationClient,
  | 'tess'
  | 'sendTessMessage'
  | 'uploadTessAttachment'
  | 'confirmTessChange'
  | 'tessUsage'
>
