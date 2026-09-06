package co.gamestation.cameraman.core

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import android.os.Process
import java.io.File

/**
 * Live CPU, memory and thermal state for this process.
 *
 * Exists to answer one question that encode and RTSP counters cannot: when the camera dies or
 * Director loses the client, was Cameraman out of RAM, out of CPU, thermally throttled, or was the
 * listener/session itself torn down? Those have different fixes and look identical from a frame
 * counter.
 */
object ProcessLoad {
    private const val nanosPerSecond = 1_000_000_000.0

    private var lastCpuJiffies: Long = 0
    private var lastSampleNanos: Long = 0

    val coreCount: Int get() = Runtime.getRuntime().availableProcessors()

    /**
     * Percentage of total machine CPU capacity this process is using, where 100 means every core is
     * saturated.
     *
     * `/proc/self/stat` is cumulative, so this is a rate between calls rather than an instantaneous
     * reading. The first call after launch has no previous sample and reports 0 rather than a
     * since-boot average, which would read as a wild spike in the first line of a soak log.
     */
    @Synchronized
    fun cpuPercent(): Double {
        val jiffies = readSelfJiffies() ?: return 0.0
        val now = System.nanoTime()
        val previousJiffies = lastCpuJiffies
        val previousNanos = lastSampleNanos
        lastCpuJiffies = jiffies
        lastSampleNanos = now
        if (previousNanos == 0L || now <= previousNanos) return 0.0

        val elapsedSeconds = (now - previousNanos) / nanosPerSecond
        // The kernel's USER_HZ is 100 on every Android ABI; there is no sysconf binding from Java.
        val usedSeconds = (jiffies - previousJiffies) / 100.0
        val cores = coreCount
        if (elapsedSeconds <= 0 || cores <= 0) return 0.0
        return (usedSeconds / elapsedSeconds / cores) * 100
    }

    /** utime + stime, fields 14 and 15 of `/proc/self/stat`. */
    private fun readSelfJiffies(): Long? = runCatching {
        val stat = File("/proc/self/stat").readText()
        // The comm field is parenthesised and may itself contain spaces, so fields are counted from
        // after the closing paren rather than from the start of the line.
        val afterComm = stat.substring(stat.lastIndexOf(')') + 2)
        val fields = afterComm.split(' ')
        // Field 3 in the whole line is state; utime is 14 and stime 15, i.e. 11 and 12 from here.
        fields[11].toLong() + fields[12].toLong()
    }.getOrNull()

    /**
     * What the app is allowed to allocate before Android kills it, in MB.
     *
     * `os_proc_available_memory` has no counterpart, so this is the per-process heap limit minus
     * what is already on the Java heap. Native allocations — every MediaCodec buffer — do not count
     * against it, which is why [physFootprintMB] is the number that actually moves under load.
     */
    fun availableMemoryMB(context: Context?): Int {
        val runtime = Runtime.getRuntime()
        val limit = context?.let {
            val manager = it.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            manager?.largeMemoryClass?.toLong()?.times(1024 * 1024)
        } ?: runtime.maxMemory()
        val used = runtime.totalMemory() - runtime.freeMemory()
        return ((limit - used) / (1024 * 1024)).toInt().coerceAtLeast(0)
    }

    /**
     * Physical memory this process is actually holding, in MB.
     *
     * PSS rather than the Java heap: the encoder, the camera and the send queues are all native, so
     * a heap reading would stay flat through exactly the leak this is here to catch. It costs a
     * few milliseconds, which is why nothing polls it faster than the state dump does.
     */
    fun physFootprintMB(): Int {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        return info.totalPss / 1024
    }

    /**
     * The thermal headroom name, mapped onto the four words the iOS build and the Director HUD
     * already speak.
     *
     * Android's `PowerManager.getCurrentThermalStatus` has seven levels to iOS's four. Collapsing
     * them here rather than at the display keeps the state dump comparable across the two builds,
     * which is the only way a soak can be read side by side.
     */
    fun thermalStateName(status: Int): String = when (status) {
        // THERMAL_STATUS_NONE, LIGHT
        0, 1 -> "nominal"
        // MODERATE
        2 -> "fair"
        // SEVERE, CRITICAL
        3, 4 -> "serious"
        // EMERGENCY, SHUTDOWN
        5, 6 -> "critical"
        else -> "unknown"
    }

    /** The process id, so a soak log can be correlated with `adb shell dumpsys`. */
    fun pid(): Int = Process.myPid()
}
