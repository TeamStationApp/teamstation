package app.teamstation.cameraman.rtsp

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Runs an [AdaptiveBitrateController] against the live server, four times a second.
 *
 * The encoder must be at the ceiling whenever [configure] is called; [configure] then says so again
 * itself, after any tick already in flight, so a cut computed against the old session can never be
 * the last word on the new one. That ordering is why every call lands on the one executor.
 */
class AdaptiveBitrateLoop(
    ceiling: Int,
    /** Half the ceiling when null. */
    floor: Int? = null,
    /** The worst playing client's link since it was last asked. Must not block. */
    private val sample: () -> CongestionSample?,
    /** Hands a rate to the encoder. Must not block. */
    private val apply: (Int) -> Unit
) {
    data class Status(val enabled: Boolean, val controller: AdaptiveBitrateController.Status)

    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { Thread(it, "adaptive-bitrate").apply { isDaemon = true } }

    // Touched only on `executor`.
    private val controller = AdaptiveBitrateController(ceiling, floor)
    private var enabled = false
    private var tick: ScheduledFuture<*>? = null

    @Volatile
    var status: Status = Status(false, controller.status)
        private set

    /**
     * A new ceiling or floor, or adaptation switched on or off. Either way the rate goes back to the
     * ceiling. [floor] is half the ceiling when null.
     */
    fun configure(ceiling: Int, floor: Int? = null, enabled: Boolean) {
        executor.execute {
            controller.reset(ceiling, floor)
            this.enabled = enabled
            if (enabled) startTicking() else stopTicking()
            apply(ceiling)
            publish()
        }
    }

    /** For good: the thread is released, and the loop takes no further calls. */
    fun stop() {
        executor.execute {
            stopTicking()
            enabled = false
            publish()
        }
        executor.shutdown()
    }

    private fun startTicking() {
        if (tick != null) return
        tick = executor.scheduleWithFixedDelay(
            { runCatching { step() } },
            tickMillis,
            tickMillis,
            TimeUnit.MILLISECONDS
        )
    }

    private fun stopTicking() {
        tick?.cancel(false)
        tick = null
    }

    private fun step() {
        if (!enabled) return
        controller.update(sample(), System.nanoTime() / 1e9)?.let(apply)
        publish()
    }

    private fun publish() {
        status = Status(enabled, controller.status)
    }

    companion object {
        /**
         * SCReAM adjusts its rate every 200 ms and belacoder every 200–250 ms. Faster than the
         * encoder can follow is wasted; slower lets a Wi-Fi burst reach the drop threshold before
         * anything reacts.
         */
        const val tickMillis = 250L
    }
}
