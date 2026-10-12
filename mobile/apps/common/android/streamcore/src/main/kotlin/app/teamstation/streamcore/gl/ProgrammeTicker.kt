package app.teamstation.streamcore.gl

/** One picture drawn into one encoder on a programme tick, stamped with [presentationNanos]. */
data class ProgrammeDraw(val key: String, val presentationNanos: Long)

/**
 * Draws a [CaptureRenderer]'s encoders on a programme clock rather than on each camera frame: TS
 * Director's programme tick, for a host with one camera.
 *
 * At [frameRate] the renderer asks [tick] which encoders take the picture it holds, and when each
 * says that picture was. A tick that names no encoder draws nothing; the preview is drawn on every
 * camera frame either way.
 */
interface ProgrammeTicker {
    val frameRate: Int

    /**
     * One tick, on the renderer's thread. [latestCaptureNanos] is the sensor timestamp of the
     * picture the renderer holds, null before the first; [attached] the keys of the encoders it can
     * draw into right now, so a picture is only ever placed where it will be drawn.
     */
    fun tick(latestCaptureNanos: Long?, attached: Set<String>): List<ProgrammeDraw>
}
