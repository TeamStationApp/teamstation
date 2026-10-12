package app.teamstation.streamcore

import app.teamstation.streamcore.bitrate.AdaptiveBitrateController
import app.teamstation.streamcore.bitrate.AdaptiveBitrateLoop
import app.teamstation.streamcore.bitrate.CongestionSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** TS Director's `AdaptiveBitrateTuningTests`: the RTMP stream's preset, on the port. */
class AdaptiveBitrateTuningTest {
    private val tick = 0.25

    private fun run(controller: AdaptiveBitrateController, delays: List<Double>, mbps: Double, offeredMbps: Double): List<Pair<Double, Int>> =
        delays.mapIndexedNotNull { index, delay ->
            val now = (index + 1) * tick
            val sample = CongestionSample(
                interval = tick,
                queueDelay = delay,
                deliveredBytes = (mbps * 1_000_000 / 8 * tick).toInt(),
                offeredBytes = (offeredMbps * 1_000_000 / 8 * tick).toInt()
            )
            controller.update(sample, now)?.let { now to it }
        }

    @Test
    fun theRtmpPresetWaitsSecondsAndTakesAStallForNoRate() {
        val preset = AdaptiveBitrateController.Tuning.rtmpStream
        assertEquals(
            AdaptiveBitrateController.Tuning(
                clearDelay = 0.25,
                growingDelay = 1.0,
                congestedDelay = 1.5,
                emergencyDelay = 5.0,
                stallShare = 0.1,
                holdWhileDraining = true
            ),
            preset
        )
        assertTrue(preset.clearDelay < preset.growingDelay)
        assertTrue(preset.growingDelay < preset.congestedDelay)
        assertTrue(preset.congestedDelay < preset.emergencyDelay)
    }

    @Test
    fun aLinkCarryingHalfTheRateIsCutToWhatItCarriesOnceTheQueueStands() {
        val controller = AdaptiveBitrateController(4_000_000, 1_000_000, AdaptiveBitrateController.Tuning.rtmpStream)
        val pushed = run(controller, (1..20).map { it * 0.125 }, mbps = 2.0, offeredMbps = 4.0)
        assertTrue(pushed.all { it.first > 2.0 })
        assertTrue(pushed.any { it.second == 1_700_000 })
        assertEquals(1_700_000, controller.bitrate)
    }

    @Test
    fun aFourSecondStallTakesFixedStepsRatherThanGoingToTheFloor() {
        val controller = AdaptiveBitrateController(4_000_000, 1_000_000, AdaptiveBitrateController.Tuning.rtmpStream)
        val pushed = run(controller, (1..16).map { it * 0.25 }, mbps = 0.0, offeredMbps = 4.0)
        assertFalse(pushed.isEmpty())
        assertTrue(pushed.all { it.second >= 3_000_000 })
        assertTrue(controller.bitrate >= 3_000_000)
    }

    @Test
    fun theDefaultTuningStillTakesAStalledLinksRateAtItsWord() {
        val controller = AdaptiveBitrateController(4_000_000, 1_000_000)
        val pushed = run(controller, (1..8).map { it * 0.25 }, mbps = 0.0, offeredMbps = 4.0)
        assertEquals(1_000_000, pushed.last().second)
    }

    @Test
    fun aStallPastFiveSecondsTakesTheLargeSteps() {
        val controller = AdaptiveBitrateController(4_000_000, 1_000_000, AdaptiveBitrateController.Tuning.rtmpStream)
        val pushed = run(controller, (1..24).map { it * 0.25 }, mbps = 0.0, offeredMbps = 4.0)
        assertTrue(pushed.filter { it.first <= 5.0 }.all { it.second >= 2_600_000 })
        assertTrue(controller.bitrate < 2_000_000)
    }

    @Test
    fun aQueueTheLinkIsAlreadyEmptyingIsNotCutAgain() {
        val controller = AdaptiveBitrateController(4_000_000, 1_000_000, AdaptiveBitrateController.Tuning.rtmpStream)
        val delays = List(4) { 0.1 } + List(12) { 2.0 }
        val pushed = run(controller, delays, mbps = 3.0, offeredMbps = 2.0)
        assertTrue(pushed.isEmpty())
        assertEquals(0, controller.status.decreases)
    }

    @Test
    fun theLoopKeepsItsTuning() {
        val applied = mutableListOf<Int>()
        val loop = AdaptiveBitrateLoop(4_000_000, 1_000_000, AdaptiveBitrateController.Tuning.rtmpStream, sample = { null }, apply = { applied += it })
        loop.configure(4_000_000, 1_000_000, enabled = false)
        loop.stop()
        Thread.sleep(100)
        assertEquals(listOf(4_000_000), applied)
    }
}
