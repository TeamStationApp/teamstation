package co.gamestation.cameraman

import co.gamestation.cameraman.rtsp.AdaptiveBitrateController
import co.gamestation.cameraman.rtsp.CongestionSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rate the encoder is told, tick by tick, for links that behave the way stadium Wi-Fi does.
 * The iOS suite runs the same scenarios and expects the same numbers.
 */
class AdaptiveBitrateControllerTest {
    companion object {
        const val tick = 0.25

        /** One tick of a link carrying [mbps] with the oldest frame waiting [delay] seconds. */
        fun sample(
            delay: Double = 0.01,
            mbps: Double,
            offeredMbps: Double? = null,
            drops: Int = 0,
            transportBacklogBytes: Int? = null
        ): CongestionSample {
            val bytes = (mbps * 1_000_000 / 8 * tick).toInt()
            return CongestionSample(
                interval = tick,
                queueDelay = delay,
                deliveredBytes = bytes,
                offeredBytes = offeredMbps?.let { (it * 1_000_000 / 8 * tick).toInt() } ?: bytes,
                transportBacklogBytes = transportBacklogBytes,
                droppedFrames = drops
            )
        }

        /** Runs [samples] a tick apart from [start], returning every rate the encoder was handed. */
        fun run(
            controller: AdaptiveBitrateController,
            samples: List<CongestionSample?>,
            start: Double = 0.0
        ): List<Int> = samples.mapIndexedNotNull { index, sample ->
            controller.update(sample, start + index * tick)
        }
    }

    @Test
    fun `a clean link stays at the ceiling`() {
        val controller = AdaptiveBitrateController(6_000_000)
        val pushed = run(controller, List(80) { sample(mbps = 6.0) })

        assertTrue(pushed.isEmpty())
        assertEquals(6_000_000, controller.bitrate)
        assertEquals(0, controller.status.decreases)
    }

    @Test
    fun `dropped frames cut at once`() {
        val controller = AdaptiveBitrateController(6_000_000)

        // No delivery rate yet, so the cut is the fixed emergency step.
        assertEquals(4_200_000, controller.update(sample(mbps = 6.0, drops = 3), 0.0))
        assertEquals(AdaptiveBitrateController.Decision.EMERGENCY, controller.status.lastDecision)
    }

    @Test
    fun `sustained congestion cuts to what the link carried`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // A link carrying 4 Mbps with a quarter of a second queued, tick after tick.
        val pushed = run(controller, List(6) { sample(delay = 0.25, mbps = 4.0) })

        // The first cut comes before a full second of delivery is measured, so it is the fixed 10%.
        // One GOP later the measured rate is known, and the cut goes to 0.85 of it.
        assertEquals(listOf(5_400_000, 3_400_000), pushed)
    }

    @Test
    fun `a latency burst on a link still carrying the rate costs one small step`() {
        val controller = AdaptiveBitrateController(6_000_000)
        val clean = List(4) { sample(mbps = 6.0) }
        val burst = List(2) { sample(delay = 0.3, mbps = 6.0) }

        assertEquals(listOf(5_100_000), run(controller, clean + burst))
    }

    @Test
    fun `a growing queue is trimmed before it is long`() {
        val controller = AdaptiveBitrateController(6_000_000)
        val pushed = run(controller, listOf(0.11, 0.12, 0.13, 0.14).map { sample(delay = it, mbps = 6.0) })

        // Trimmed on the third rising tick, then held for a GOP.
        assertEquals(listOf(5_700_000), pushed)
        assertEquals(1, controller.status.decreases)
    }

    @Test
    fun `the rate never goes below half the ceiling`() {
        val controller = AdaptiveBitrateController(6_000_000)
        val pushed = run(controller, List(40) { sample(delay = 2.0, mbps = 0.5, drops = 1) })

        assertTrue(pushed.all { it >= 3_000_000 })
        assertEquals(3_000_000, controller.bitrate)
        assertEquals(3_000_000, controller.floor)
    }

    @Test
    fun `a standing transport backlog on a link falling short counts as queue`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // A second of a clean link with a round trip's worth in flight, then the link carries 3 Mbps
        // of the encoder's 6 and 400 KB builds in TCP: congestion, cut to 0.85 of the 3.75 Mbps the
        // last second carried.
        val clean = List(4) { sample(mbps = 6.0, transportBacklogBytes = 8_000) }
        val backlog = List(3) {
            sample(delay = 0.0, mbps = 3.0, offeredMbps = 6.0, transportBacklogBytes = 400_000)
        }

        assertEquals(listOf(3_100_000), run(controller, clean + backlog))
        assertEquals(AdaptiveBitrateController.Decision.CONGESTED, controller.status.lastDecision)
    }

    @Test
    fun `a longer round trip on a link that keeps up is not queue`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // 150 ms more each way puts 240 KB in flight — 320 ms at 6 Mbps — but the link still
        // carries everything the encoder makes, so nothing is waiting.
        val clean = List(4) { sample(mbps = 6.0, transportBacklogBytes = 8_000) }
        val longer = List(40) { sample(mbps = 6.0, transportBacklogBytes = 240_000) }

        assertTrue(run(controller, clean + longer).isEmpty())
    }

    @Test
    fun `bytes in flight on a clean link are not queue`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // 20 KB in flight is 27 ms at 6 Mbps, every tick, for 20 s.
        val pushed = run(controller, List(80) { sample(mbps = 6.0, transportBacklogBytes = 20_000) })

        assertTrue(pushed.isEmpty())
        assertEquals(27, controller.status.transportBaseMilliseconds)
    }

    @Test
    fun `a keyframe burst in the transport is not queue`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // A 150 KB keyframe in the kernel once a second, gone by the next tick: 200 ms if it counted.
        val second = listOf(150_000, 10_000, 10_000, 10_000).map { sample(mbps = 6.0, transportBacklogBytes = it) }
        val pushed = run(controller, List(20) { second }.flatten())

        assertTrue(pushed.isEmpty())
    }

    @Test
    fun `the rate waits for a clean link then climbs back to the ceiling`() {
        val controller = AdaptiveBitrateController(6_000_000)
        assertEquals(4_200_000, controller.update(sample(mbps = 6.0, drops = 1), 0.0))

        val increases = ArrayList<Pair<Double, Int>>()
        var now = 0.0
        while (now < 40 && controller.bitrate < 6_000_000) {
            now += tick
            // A clean link carries whatever the encoder was last told to produce.
            val clean = sample(mbps = controller.bitrate / 1_000_000.0)
            controller.update(clean, now)?.let { increases.add(now to it) }
        }

        assertEquals(6_000_000, controller.bitrate)
        // No climb until the link has been clean for 4 s.
        assertTrue(increases.first().first >= 4)
        // Back at the ceiling in well under half a minute.
        assertTrue(now < 25)
        // Increases reach the encoder at most once a second, and only ever upwards.
        assertTrue(increases.zipWithNext().all { (a, b) -> b.first - a.first >= 1 })
        assertTrue(increases.zipWithNext().all { (a, b) -> a.second < b.second })
    }

    @Test
    fun `the climb slows near what the link carried, not where the cut started`() {
        val controller = AdaptiveBitrateController(6_000_000)
        // A second of a link carrying 3.5 Mbps, then a drop: the cut lands on the 3 Mbps floor.
        run(controller, List(4) { sample(mbps = 3.5) })
        assertEquals(3_000_000, controller.update(sample(mbps = 3.5, drops = 1), 1.0))

        var now = 1.0
        var reachedCapacityAt: Double? = null
        while (now < 30 && reachedCapacityAt == null) {
            now += tick
            controller.update(sample(mbps = controller.bitrate / 1_000_000.0), now)
            if (controller.bitrate >= 3_500_000) reachedCapacityAt = now
        }

        // Four seconds' hold, then under 3% a second near 3.5 Mbps rather than 8%: GCC's full rate
        // would get there in two seconds and find the same congestion.
        assertTrue((reachedCapacityAt ?: 0.0) - 5 >= 5)
    }

    @Test
    fun `nobody playing for long starts the next client at the ceiling`() {
        val controller = AdaptiveBitrateController(6_000_000)
        controller.update(sample(mbps = 6.0, drops = 1), 0.0)

        // A short gap holds the rate.
        assertNull(controller.update(null, 5.0))
        assertEquals(6_000_000, controller.update(null, 10.25))
    }

    @Test
    fun `a reset starts at the new ceiling and keeps the session counts`() {
        val controller = AdaptiveBitrateController(6_000_000)
        controller.update(sample(mbps = 6.0, drops = 1), 0.0)
        controller.reset(8_000_000)

        assertEquals(8_000_000, controller.bitrate)
        assertEquals(4_000_000, controller.floor)
        assertEquals(1, controller.status.decreases)
    }
}
