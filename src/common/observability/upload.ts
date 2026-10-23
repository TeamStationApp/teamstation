import type { AnalyticsSink } from './apiEvents'

/** Observe the existing upload promise; never retain its title, token or destination. */
export async function observeUpload(
  work: () => Promise<string>,
  capture?: () => AnalyticsSink,
  retry = false
): Promise<string> {
  let sink: AnalyticsSink | undefined
  try {
    sink = capture?.()
  } catch {}
  const emit: AnalyticsSink = (event, properties) => {
    try {
      sink?.(event, properties)
    } catch {}
  }
  if (retry) emit('upload_retry', {})
  emit('upload_started', {})
  try {
    const videoId = await work()
    emit(
      'upload_completed',
      /^vid_[A-Za-z0-9_-]{1,96}$/.test(videoId) ? { vi: videoId } : {}
    )
    return videoId
  } catch (error) {
    emit('upload_failed', { ec: 'internal' })
    throw error
  }
}
