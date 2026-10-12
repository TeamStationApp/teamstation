package app.teamstation.streamcore.phonestream

/**
 * How far TeamStation's clock is from this phone's, measured with `GET /api/v1/time`, by the rule of
 * TeamStationKit's `ServerClock`, which TS Director and the iPhone measure with.
 *
 * A phone's clock can be a second out: this Pixel read 1.04 s ahead of true time, which put its angle a
 * second behind an iPhone's of the same play. One measurement is [TRIPS_PER_SAMPLE] requests, one after
 * another, of which the one with the shortest round trip is kept: a slow answer is slow on one leg or
 * the other, and the offset is the server's reading less the middle of the trip, so the shortest trip
 * has the least room to be wrong.
 */
object ServerClock {
    /** Requests per measurement. */
    const val TRIPS_PER_SAMPLE = 5

    /** One request: this phone's clock either side of it, in seconds, and the server's in between, in milliseconds. */
    data class Trip(val sent: Double, val serverMs: Double, val received: Double) {
        val roundTripMs: Double get() = (received - sent) * 1000
    }

    /** One measurement: the server's clock less this phone's, and the round trip it is right to within half of, in milliseconds. */
    data class Sample(val offsetMs: Int, val rttMs: Int)

    /**
     * The sample the trip with the shortest round trip gives, the earliest of equals: the server's
     * reading less the middle of the trip. Null with no trip.
     */
    fun best(trips: List<Trip>): Sample? {
        val trip = trips.minByOrNull { it.roundTripMs } ?: return null
        val middleMs = (trip.sent + trip.received) * 500
        return Sample(offsetMs = Math.round(trip.serverMs - middleMs).toInt(), rttMs = Math.round(trip.roundTripMs).toInt())
    }
}
