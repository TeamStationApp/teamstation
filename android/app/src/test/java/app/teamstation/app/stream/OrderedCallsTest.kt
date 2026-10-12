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

/** Zoom, pinch and rotation calls reach the engine in the order JavaScript made them. */
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
}
