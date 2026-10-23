/**
 * Tess's shapes as the chat sees them: the conversation the server keeps for
 * the signed-in user, and the five calls that read and change it.
 *
 * Tool calls and tool results never reach the client. An assistant message
 * carries the changes it proposed, each as the server stored it, so the card
 * shows what will run rather than what the model said about it.
 */

export type TessAttachmentKind = 'image' | 'csv' | 'text' | 'markdown'

export interface TessAttachmentRef {
  id: string
  name: string
  kind: TessAttachmentKind
  /** Compaction replaced the file with a description of it. */
  described: boolean
}

export type TessChangeStatus =
  'pending' | 'running' | 'done' | 'failed' | 'expired'

export interface TessChange {
  id: string
  /** The model's words for the change. */
  summary: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Under `/api/v1`, as the server will call it. */
  path: string
  body: unknown
  status: TessChangeStatus
}

export interface TessMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments: TessAttachmentRef[]
  changes: TessChange[]
  createdAt: string
}

/** The right pane's place in the app, sent on wide screens only. */
export interface TessScreen {
  path: string
  title: string
  stack: Array<{ path: string; title: string }>
}

export interface TessConversation {
  available: boolean
  messages: TessMessage[]
  contextTokens: number
}

/** A file on its way to the server: its bytes are base64. */
export interface TessUpload {
  name: string
  mediaType: string
  data: string
}

export interface TessUsageWeek {
  weekStart: string
  inputTokens: number
  outputTokens: number
  requests: number
}

/** The part of `TeamStationClient` the chat calls. */
export interface TessApi {
  tess: () => Promise<TessConversation>
  sendTessMessage: (request: {
    text: string
    attachmentIds?: string[]
    screen?: TessScreen
  }) => Promise<{ messages: TessMessage[] }>
  uploadTessAttachment: (
    upload: TessUpload
  ) => Promise<{ id: string; name: string; kind: TessAttachmentKind }>
  confirmTessChange: (
    changeId: string
  ) => Promise<{ change: TessChange; messages: TessMessage[] }>
  tessUsage: () => Promise<{ weeks: TessUsageWeek[] }>
}
