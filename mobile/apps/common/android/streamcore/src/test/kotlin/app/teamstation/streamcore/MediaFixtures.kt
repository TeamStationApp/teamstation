package app.teamstation.streamcore

import java.io.File

/**
 * The golden vectors TS Director's unit tests write to `mobile/apps/common/MediaFixtures/`
 * (`MediaFixtureWriter`). The port asserts the same files, so a change to Director's behaviour fails
 * here until it is ported.
 */
object MediaFixtures {
    val directory: File by lazy {
        val configured = System.getProperty("mediaFixtures")?.let(::File)
        configured?.takeIf { it.isDirectory }
            ?: generateSequence(File("").absoluteFile) { it.parentFile }
                .map { File(it, "MediaFixtures") }
                .first { it.isDirectory }
    }

    fun bytes(name: String): ByteArray = File(directory, name).readBytes()

    @Suppress("UNCHECKED_CAST")
    fun json(name: String): Map<String, Any?> = Json.parse(File(directory, name).readText()) as Map<String, Any?>
}

/** Just enough JSON for the fixtures: objects, arrays, strings, numbers as Double, booleans and null. */
object Json {
    fun parse(text: String): Any? {
        val parser = Parser(text)
        val value = parser.value()
        parser.skipSpace()
        require(parser.done) { "trailing text at ${parser.position}" }
        return value
    }

    private class Parser(val text: String) {
        var position = 0
        val done: Boolean get() = position >= text.length

        fun skipSpace() {
            while (!done && text[position].isWhitespace()) position += 1
        }

        fun value(): Any? {
            skipSpace()
            return when (val c = text[position]) {
                '{' -> obj()
                '[' -> array()
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) number() else error("unexpected $c at $position")
            }
        }

        fun literal(word: String, value: Any?): Any? {
            require(text.startsWith(word, position))
            position += word.length
            return value
        }

        fun number(): Double {
            val start = position
            while (!done && (text[position].isDigit() || text[position] in "+-.eE")) position += 1
            return text.substring(start, position).toDouble()
        }

        fun string(): String {
            position += 1
            val out = StringBuilder()
            while (text[position] != '"') {
                val c = text[position]
                if (c == '\\') {
                    val escaped = text[position + 1]
                    position += 2
                    when (escaped) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'r' -> out.append('\r')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'u' -> {
                            out.append(text.substring(position, position + 4).toInt(16).toChar())
                            position += 4
                        }
                        else -> out.append(escaped)
                    }
                } else {
                    out.append(c)
                    position += 1
                }
            }
            position += 1
            return out.toString()
        }

        fun array(): List<Any?> {
            position += 1
            val items = mutableListOf<Any?>()
            skipSpace()
            if (text[position] == ']') {
                position += 1
                return items
            }
            while (true) {
                items += value()
                skipSpace()
                val c = text[position++]
                if (c == ']') return items
                require(c == ',') { "expected , at $position" }
            }
        }

        fun obj(): Map<String, Any?> {
            position += 1
            val pairs = LinkedHashMap<String, Any?>()
            skipSpace()
            if (text[position] == '}') {
                position += 1
                return pairs
            }
            while (true) {
                skipSpace()
                val key = string()
                skipSpace()
                require(text[position++] == ':')
                pairs[key] = value()
                skipSpace()
                val c = text[position++]
                if (c == '}') return pairs
                require(c == ',') { "expected , at $position" }
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
fun Any?.obj(): Map<String, Any?> = this as Map<String, Any?>

@Suppress("UNCHECKED_CAST")
fun Any?.list(): List<Any?> = this as List<Any?>

fun Any?.double(): Double = (this as Number).toDouble()

fun Any?.int(): Int = (this as Number).toInt()

fun Any?.long(): Long = (this as Number).toLong()

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }
