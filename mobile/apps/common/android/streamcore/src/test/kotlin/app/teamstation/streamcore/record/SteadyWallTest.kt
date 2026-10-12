package app.teamstation.streamcore.record

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The steady wall clock: anchored once, carried forward on uptime, never stepped by the wall clock. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SteadyWallTest {
    @Test
    fun aStepOfTheWallClockMovesNothing() {
        var wall = 1_000.0
        var uptime = 50.0
        val steady = SteadyWall(wall = { wall }, uptime = { uptime })
        assertEquals(950.0, steady.offsetSeconds, 0.0)
        assertEquals(1_000.0, steady.seconds(), 0.0)
        uptime += 2.5
        wall -= 0.1
        assertEquals(1_002.5, steady.seconds(), 0.0)
        assertEquals(1_002.5, SteadyClock(steady).now(), 0.0)
    }

    @Test
    fun theSharedClockFollowsRealTime() {
        val now = System.currentTimeMillis() / 1000.0
        assertTrue(kotlin.math.abs(SteadyClock().now() - now) < 5)
        assertTrue(SteadyWall.elapsedRealtime() >= 0)
    }
}
