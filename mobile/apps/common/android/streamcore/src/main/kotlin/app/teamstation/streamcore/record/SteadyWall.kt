package app.teamstation.streamcore.record

import android.os.SystemClock

/**
 * The wall clock as the live path reads it: the device's wall clock at the anchor, carried forward on
 * `SystemClock.elapsedRealtimeNanos` (uptime that keeps counting in deep sleep), so it never steps. A
 * port of TS Director's `SteadyWall`.
 *
 * The phone's own wall clock is stepped by network time. Every live-path decision compares two
 * instants (a picture's capture against the programme tick, a run of the mix against the last, a
 * stream stamp against the stream's start), and on this clock those comparisons see only elapsed
 * time. A label it gives (a file name, a take's start) is off real time only by what network time has
 * corrected since the anchor.
 */
class SteadyWall(
    wall: () -> Double = { System.currentTimeMillis() / 1000.0 },
    private val uptime: () -> Double = ::elapsedRealtime
) {
    /** Wall clock less uptime at the anchor: what turns an uptime into a wall time. */
    val offsetSeconds: Double = wall() - uptime()

    /** Seconds since 1970 on the steady wall clock. */
    fun seconds(): Double = uptime() + offsetSeconds

    companion object {
        /** The process's one steady wall clock, anchored at first use. */
        val shared: SteadyWall by lazy { SteadyWall() }

        /** `elapsedRealtimeNanos` in seconds. */
        fun elapsedRealtime(): Double = SystemClock.elapsedRealtimeNanos() / 1e9
    }
}

/** An injectable wall clock, in seconds since 1970. TS Director's `DirectorClock`. */
fun interface DirectorClock {
    fun now(): Double
}

/** The steady wall clock as a [DirectorClock]: TS Director's `SystemClock`. */
class SteadyClock(private val steady: SteadyWall = SteadyWall.shared) : DirectorClock {
    override fun now(): Double = steady.seconds()
}
