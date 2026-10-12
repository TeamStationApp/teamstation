package app.teamstation.streamcore.record

/**
 * What to do at launch about whatever the app was doing when it last stopped running. A port of TS
 * Director's `LiveSessionResume`: a decision, not an action, so the rules are testable. The recording
 * and the stream come back independently, and an hour away is the difference between a take that
 * continues as its next part and one that is closed.
 */
data class LiveSessionResume(val outcome: Outcome, val downtime: Double) {
    /** Everything needed to put a take back the way it was. */
    data class Take(
        val recordingID: Long,
        /** The take's own start, not the moment it was picked up. */
        val startedAt: Double,
        /** The grid a Director take was recording with, as the row keeps it; null on a phone. */
        val selections: String?,
        /** The part number a resumed programme encoder should open. */
        val nextProgramPart: Int
    )

    sealed interface Outcome {
        /** At least one of the two is set. A streaming-only session opens no recording at all. */
        data class Resume(val recording: Take?, val streaming: Boolean) : Outcome

        /** The app was away too long; the take, if there was one, is closed by the host. */
        data class Expired(val closedRecordingID: Long?) : Outcome
    }

    /** The take to leave open through the launch, if any. */
    val liveRecordingID: Long? get() = (outcome as? Outcome.Resume)?.recording?.recordingID

    val isExpired: Boolean get() = outcome is Outcome.Expired

    /** How the operator is told, in one line. */
    fun banner(limit: Double): String = when (outcome) {
        is Outcome.Resume -> {
            val what = when {
                outcome.recording != null && outcome.streaming -> "Resumed recording and stream"
                outcome.recording != null -> "Resumed recording"
                else -> "Resumed stream"
            }
            "$what — app was away ${spell(downtime)}"
        }
        is Outcome.Expired -> "Take closed — app was away ${spell(downtime)}, longer than the ${spell(limit)} resume limit"
    }

    companion object {
        /** How long the app may be away before an interrupted take is closed rather than resumed. */
        const val defaultLimitSeconds = 3_600.0

        /**
         * Reads the catalog and decides. Nothing is closed or resumed here; the one write is the
         * repair [RecordingCatalog.liveRecording] makes to a pointer at a take since closed. Null
         * when the app was idle when it stopped.
         */
        fun plan(catalog: RecordingCatalog, now: Double, limit: Double = defaultLimitSeconds): LiveSessionResume? {
            val session = catalog.liveSession() ?: return null
            if (session.isEmpty) return null
            val downtime = maxOf(0.0, now - session.lastAlive)
            val summary = catalog.liveRecording()
            if (downtime > limit) return LiveSessionResume(Outcome.Expired(summary?.id), downtime)
            val take = summary?.let {
                Take(
                    recordingID = it.id,
                    startedAt = it.startedAt,
                    selections = catalog.selections(it.id),
                    nextProgramPart = catalog.nextProgramPart(it.id)
                )
            }
            if (take == null && !session.streaming) return null
            return LiveSessionResume(Outcome.Resume(take, session.streaming), downtime)
        }

        fun spell(seconds: Double): String {
            val whole = seconds.roundedToLong()
            if (whole < 60) return "${whole}s"
            val minutes = whole / 60
            if (minutes < 60) return "${minutes}m ${whole % 60}s"
            return "${minutes / 60}h ${minutes % 60}m"
        }

        private fun Double.roundedToLong(): Long = kotlin.math.floor(this + 0.5).toLong()
    }
}
