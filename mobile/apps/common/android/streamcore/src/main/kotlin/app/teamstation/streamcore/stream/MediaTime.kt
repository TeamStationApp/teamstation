package app.teamstation.streamcore.stream

/**
 * A rational time, `value / timescale` seconds: the part of Core Media's `CMTime` the ported
 * timelines use, so their arithmetic lands on the same numbers as TS Director's. Negative infinity
 * stands for "no time yet".
 */
data class MediaTime(val value: Long, val timescale: Int, val isNegativeInfinity: Boolean = false) : Comparable<MediaTime> {
    val isNumeric: Boolean get() = !isNegativeInfinity && timescale > 0

    val seconds: Double get() = if (isNumeric) value.toDouble() / timescale else Double.NEGATIVE_INFINITY

    operator fun plus(other: MediaTime): MediaTime {
        if (!isNumeric || !other.isNumeric) return negativeInfinity
        val scale = lcm(timescale, other.timescale)
        return MediaTime(value * (scale / timescale) + other.value * (scale / other.timescale), scale)
    }

    operator fun minus(other: MediaTime): MediaTime {
        if (!isNumeric || !other.isNumeric) return negativeInfinity
        val scale = lcm(timescale, other.timescale)
        return MediaTime(value * (scale / timescale) - other.value * (scale / other.timescale), scale)
    }

    override fun compareTo(other: MediaTime): Int {
        if (isNegativeInfinity || other.isNegativeInfinity) {
            return isNegativeInfinity.compareTo(other.isNegativeInfinity) * -1
        }
        val scale = lcm(timescale, other.timescale)
        return (value * (scale / timescale)).compareTo(other.value * (scale / other.timescale))
    }

    companion object {
        val zero = MediaTime(0, 1)
        val negativeInfinity = MediaTime(0, 0, isNegativeInfinity = true)

        /**
         * [seconds] at [timescale], truncated toward zero as `CMTime(seconds:preferredTimescale:)` is:
         * the stream clock's fixture has 1/30 s after a large epoch come out as 19/600, not 20/600.
         */
        fun seconds(seconds: Double, timescale: Int): MediaTime = MediaTime((seconds * timescale).toLong(), timescale)

        private fun gcd(a: Long, b: Long): Long = if (b == 0L) a else gcd(b, a % b)

        private fun lcm(a: Int, b: Int): Int = (a.toLong() / gcd(a.toLong(), b.toLong()) * b).toInt()
    }
}

/** Swift's `.rounded()`: to nearest, halves away from zero. Kotlin's `round` takes halves to even. */
fun Double.roundedHalfAwayFromZero(): Double {
    val whole = kotlin.math.truncate(this)
    return if (kotlin.math.abs(this - whole) == 0.5) whole + kotlin.math.sign(this) else Math.rint(this)
}
