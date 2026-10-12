package app.teamstation.app.stream

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Runs suspending calls one at a time, in the order they were handed over, on [scope]. A call that
 * throws goes to [onError] and the next still runs. For calls whose order is their meaning: a pinch's
 * end must not overtake its last change, nor an older rotation a newer one.
 */
class OrderedCalls(scope: CoroutineScope, private val onError: (Throwable) -> Unit) {
    private val calls = Channel<suspend () -> Unit>(Channel.UNLIMITED)

    init {
        scope.launch {
            for (call in calls) {
                try {
                    call()
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    onError(error)
                }
            }
        }
    }

    /** Queues [call] behind every call handed over before it. */
    fun run(call: suspend () -> Unit) {
        calls.trySend(call)
    }
}
