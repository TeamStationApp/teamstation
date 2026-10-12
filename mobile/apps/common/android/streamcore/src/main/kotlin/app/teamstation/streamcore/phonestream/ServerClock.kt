package app.teamstation.streamcore.phonestream

/**
 * How far this phone's clock is from TeamStation's, so the instants it reports (when a stream's first
 * picture was captured, when an upload's first frame was) are on the server's clock. A port of
 * TeamStationKit's `ServerClock`.
 *
 * A phone's clock can be a second out: this Pixel read 1.04 s ahead of true time, which put its angle a
 * second behind an iPhone's of the same play. The offset is Cristian's: ask for the server's time, note
 * when the question left and the answer came back, and take the server's reading as the midpoint. The
 * shortest of a few round trips wins, because its midpoint can be furthest from the truth by the least.
 */
object ServerClock {
    /** One round trip: this phone's clock as it left and as it came back, and the server's, in seconds. */
    data class Sample(val sent: Double, val server: Double, val received: Double) {
        val roundTrip: Double get() = received - sent
    }

    /** How many round trips an estimate takes: enough that one of them is likely quick. */
    const val SAMPLES = 4

    /**
     * What to add to this phone's clock to read the server's, from the sample with the shortest round
     * trip. Null with no sample whose answer came after its question.
     */
    fun offset(samples: List<Sample>): Double? =
        samples.filter { it.roundTrip >= 0 }.minByOrNull { it.roundTrip }?.let { it.server - (it.sent + it.received) / 2 }
}
