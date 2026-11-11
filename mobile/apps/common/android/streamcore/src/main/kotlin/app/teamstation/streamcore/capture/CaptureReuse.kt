package app.teamstation.streamcore.capture

/** Only a healthy, already-running session can preserve its capture state during settings edits. */
internal fun canReuseCapture(
    recovering: Boolean, failure: String?, running: Boolean,
    sameDevice: Boolean, hasSession: Boolean, hasBuilder: Boolean
): Boolean = !recovering && failure == null && running && sameDevice && hasSession && hasBuilder
