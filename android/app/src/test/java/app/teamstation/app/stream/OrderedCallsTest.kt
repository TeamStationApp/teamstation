package app.teamstation.app.stream

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.util.Collections

/** Every call that sets the engine's state reaches it in the order JavaScript made it. */
class OrderedCallsTest {
    @Test
    fun callsRunOneAtATimeInTheOrderTheyCame() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val errors = Collections.synchronizedList(mutableListOf<Throwable>())
            val calls = OrderedCalls(scope) { errors += it }
            val seen = Collections.synchronizedList(mutableListOf<Int>())
            var running = 0
            repeat(300) { index ->
                calls.run {
                    running += 1
                    if (running != 1) fail("two calls at once")
                    // Some calls take longer, which reorders separately launched ones.
                    if (index % 7 == 0) delay(1)
                    running -= 1
                    if (index == 5) throw IllegalStateException("refused")
                    seen += index
                }
            }
            val deadline = System.nanoTime() + 10_000_000_000L
            while (seen.size < 299 && System.nanoTime() < deadline) Thread.sleep(5)
            assertEquals((0 until 300).filter { it != 5 }, seen.toList())
            assertEquals("refused", errors.single().message)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun callsThatAnswerSettleInTheOrderTheyCame() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val calls = OrderedCalls(scope) { fail("an answered call reached onError: $it") }
            val settled = Collections.synchronizedList(mutableListOf<String>())
            // A mute, an unmute, a lens change and another: each settles in turn, the slow first ones too.
            calls.call({ delay(20); "audio off" }) { settled += it.getOrThrow() }
            calls.call({ delay(5); "audio on" }) { settled += it.getOrThrow() }
            calls.call({ throw IllegalStateException("refused") }) { settled += "failed ${it.exceptionOrNull()?.message}" }
            calls.call({ "lenses" }) { settled += it.getOrThrow() }
            val deadline = System.nanoTime() + 10_000_000_000L
            while (settled.size < 4 && System.nanoTime() < deadline) Thread.sleep(5)
            assertEquals(listOf("audio off", "audio on", "failed refused", "lenses"), settled.toList())
        } finally {
            scope.cancel()
        }
    }
}
