package app.teamstation.app.video

import org.junit.Assert.assertTrue
import org.junit.Test

/** A live playlist that has gone quiet is waited for as long as the server keeps it open. */
class LivePlaylistPatienceTest {
    @Test
    fun waitsOutTheGraceForTheServersSixSecondSegments() {
        // Media3's own 3.5 target durations is 21 s of these.
        assertTrue(LivePlaylistPatience.stuckAfterMs(6_000) > LivePlaylistPatience.GRACE_MS)
    }

    @Test
    fun waitsOutTheGraceForTheShortestTargetItIsWorkedOutFor() {
        assertTrue(
            LivePlaylistPatience.stuckAfterMs(LivePlaylistPatience.SHORTEST_TARGET_MS) >=
                LivePlaylistPatience.GRACE_MS + LivePlaylistPatience.MARGIN_MS,
        )
    }

    @Test
    fun matchesTheServersGrace() {
        // RECONNECT_GRACE_MS in src/server/live/controller.ts.
        assertTrue(LivePlaylistPatience.GRACE_MS == 8 * 60 * 1000L)
    }
}
