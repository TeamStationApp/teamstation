package app.teamstation.cameraman.eventcontrol

import java.math.BigInteger

/** Exact account IDs; decimal conversion is restricted to saved pre-migration state. */
internal object TeamStationUserId {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    private val radix = BigInteger.valueOf(58)
    private val maximum = BigInteger.ONE.shiftLeft(128).subtract(BigInteger.ONE)

    fun canonical(text: String): String? {
        if (text.length != 26 || !text.startsWith("usr_")) return null
        var value = BigInteger.ZERO
        for (char in text.substring(4)) {
            val digit = ALPHABET.indexOf(char)
            if (digit < 0) return null
            value = value.multiply(radix).add(BigInteger.valueOf(digit.toLong()))
        }
        return text.takeIf { value.signum() > 0 && value <= maximum && encode(value) == text }
    }

    fun fromLegacyDecimal(text: String): String? {
        if (text.isEmpty() || text[0] !in '1'..'9' || !text.all { it in '0'..'9' }) return null
        val value = text.toLongOrNull() ?: return null
        if (value > 9_007_199_254_740_991L) return null
        return encode(BigInteger.valueOf(value))
    }

    fun upgradingStored(text: String): String? = canonical(text) ?: fromLegacyDecimal(text)

    private fun encode(input: BigInteger): String {
        var value = input
        val digits = StringBuilder()
        while (value.signum() > 0) {
            val parts = value.divideAndRemainder(radix)
            digits.append(ALPHABET[parts[1].toInt()])
            value = parts[0]
        }
        return "usr_" + digits.reverse().toString().padStart(22, '1')
    }
}
