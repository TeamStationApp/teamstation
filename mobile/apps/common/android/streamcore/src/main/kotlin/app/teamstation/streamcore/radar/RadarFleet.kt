package app.teamstation.streamcore.radar

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.CopyOnWriteArrayList

/** Where one paired radar's link stands. */
enum class RadarConnection {
    /** The radar is turned off on this phone. */
    off,

    /** Looking for the paired serial. */
    scanning,
    connecting,
    connected,

    /** Bluetooth, or what scanning needs with it (location, the permission), is unavailable. */
    bluetoothOff
}

/**
 * What the fleet publishes for each paired radar. The speeds are the last nonzero pitch and exit,
 * and [readingAt] is when the latest of them arrived, in wall-clock milliseconds.
 */
data class RadarDeviceState(
    val serial: String,
    val connection: RadarConnection,
    val batteryPercent: Int? = null,
    val pitchMph: Int? = null,
    val exitMph: Int? = null,
    val readingAt: Long? = null
)

/** Where a host keeps its radar switch and its paired serials. */
interface RadarFleetStore {
    fun readSerials(): List<String>
    fun writeSerials(serials: List<String>)
    fun readEnabled(): Boolean
    fun writeEnabled(enabled: Boolean)
}

/**
 * Any number of paired TAG One radars, one [RadarLink] each with its own [RadarRadio], up to
 * [limit].
 *
 * [scan] lists the radars in range that are not paired yet, on a radio of the fleet's own; [pair]
 * and [unpair] change the set, and [setEnabled] turns every link on or off. The host calls
 * [refresh] when Bluetooth, location or the permission changes.
 *
 * TS Cameraman runs it with a limit of one and draws [cameramanState], the single link's state with
 * the picker filled from the scan, so its card and viewfinder read exactly as they did with one
 * link. The uiTest commands [show], [feed] and [setStep] reach that link too.
 */
class RadarFleet(
    private val store: RadarFleetStore,
    private val newRadio: () -> RadarRadio,
    private val bluetoothOn: () -> Boolean,
    private val locationOn: () -> Boolean,
    private val permissionsGranted: () -> Boolean,
    private val log: (String) -> Unit,
    private val later: (Long, () -> Unit) -> Unit = { delayMs, block ->
        Handler(Looper.getMainLooper()).postDelayed(block, delayMs)
    },
    limit: Int = Int.MAX_VALUE
) {
    val limit: Int = limit.coerceAtLeast(1)

    private class Member(
        val serial: String,
        val link: RadarLink,
        val radio: TrackedRadio,
        /** False for a radar a uiTest `show` put on screen without pairing it. */
        val paired: Boolean
    )

    /** Knows whether its link has a scan running, which [RadarUiState] does not say. */
    private class TrackedRadio(val inner: RadarRadio) : RadarRadio by inner {
        var scanning = false
            private set

        override fun startScan(onName: (String) -> Unit) {
            scanning = true
            inner.startScan(onName)
        }

        override fun stopScan() {
            scanning = false
            inner.stopScan()
        }
    }

    /** A link's own view of the store: its serial, the fleet's switch, and no writes of its own. */
    private class LinkStore(private val serial: String, private val enabled: () -> Boolean) :
        RadarPairingStore {
        override fun read(): String = serial
        override fun write(serial: String?) = Unit
        override fun readEnabled(): Boolean = enabled()
    }

    /**
     * Changed on the main thread and read from the GATT and scan threads that report a link's
     * state, so a reader always iterates a whole list.
     */
    private val members = CopyOnWriteArrayList<Member>()
    private var enabledNow = true
    private var scanRadio: RadarRadio? = null
    private var radioScanning = false

    private val devicesFlow = MutableStateFlow<List<RadarDeviceState>>(emptyList())
    val devices: StateFlow<List<RadarDeviceState>> = devicesFlow.asStateFlow()
    private val nearbyFlow = MutableStateFlow<List<String>>(emptyList())

    /** Radars in range that are not paired, in the order they were heard, while scanning. */
    val nearby: StateFlow<List<String>> = nearbyFlow.asStateFlow()
    private val scanningFlow = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = scanningFlow.asStateFlow()
    private val enabledFlow = MutableStateFlow(true)
    val enabled: StateFlow<Boolean> = enabledFlow.asStateFlow()
    private val cameramanFlow = MutableStateFlow(RadarUiState())

    /** The first radar as TS Cameraman's single-radar card and viewfinder draw it. */
    val cameramanState: StateFlow<RadarUiState> = cameramanFlow.asStateFlow()

    /** A pitch or exit that just arrived from the radar with this serial. */
    var onSpeeds: ((serial: String, pitchMph: Int, exitMph: Int) -> Unit)? = null

    val serials: List<String> get() = members.filter { it.paired }.map { it.serial }

    fun start() {
        enabledNow = store.readEnabled()
        enabledFlow.value = enabledNow
        for (serial in store.readSerials().take(limit)) {
            if (member(serial) == null) add(serial, paired = true)
        }
        publish()
    }

    fun setEnabled(on: Boolean) {
        store.writeEnabled(on)
        enabledNow = on
        enabledFlow.value = on
        for (member in members) member.link.setEnabled(on)
        applyScan()
        publish()
    }

    /**
     * Starts listing radars in range that are not paired. While the fleet is off the list stays
     * open and empty, as Cameraman's picker always has, and the radio waits for the switch.
     */
    fun scan() {
        scanningFlow.value = true
        nearbyFlow.value = emptyList()
        applyScan()
        publish()
    }

    fun stopScan() {
        endScan()
        publish()
    }

    /** Bluetooth, location or the permission changed: every link and the scan look again. */
    fun refresh() {
        for (member in members) member.link.refresh()
        applyScan()
        publish()
    }

    /**
     * Pairs [serial], dropping the oldest pairing when the fleet is full. False for a name that is
     * not a TAG One or is already paired.
     */
    fun pair(serial: String): Boolean {
        val name = RadarPairingRecord.serialFrom(serial) ?: return false
        val existing = member(name)
        if (existing?.paired == true) return false
        if (existing != null) remove(existing)
        while (members.count { it.paired } >= limit) remove(members.first { it.paired })
        nearbyFlow.value = nearbyFlow.value.filterNot { it.equals(name, ignoreCase = true) }
        add(name, paired = true)
        persist()
        publish()
        return true
    }

    fun unpair(serial: String) {
        val member = member(serial) ?: return
        remove(member)
        if (member.paired) persist()
        publish()
    }

    /** Every radar goes, paired or only shown. */
    fun unpairAll() {
        val had = members.any { it.paired }
        members.forEach { remove(it) }
        if (had) persist()
        publish()
    }

    /** uiTest: draws [RadarCommand.Show]'s serial and phase without touching the radio. */
    fun show(command: RadarCommand.Show) {
        val member = member(command.serial) ?: members.firstOrNull() ?: add(command.serial, paired = false)
        member.link.show(command)
        publish()
    }

    /** uiTest: a reading as the first radar would report it; with none, it still reaches [onSpeeds]. */
    fun feed(command: RadarCommand.Feed) {
        val member = members.firstOrNull()
        if (member != null) {
            member.link.feed(command)
        } else if (command.pitch > 0 || command.exit > 0) {
            onSpeeds?.invoke("", command.pitch, command.exit)
        }
        publish()
    }

    /** The connecting dots of the first radar, which the card animates. */
    fun setStep(step: Int) {
        members.firstOrNull()?.link?.setStep(step)
    }

    private fun member(serial: String): Member? =
        members.firstOrNull { it.serial.equals(serial, ignoreCase = true) }

    private fun add(serial: String, paired: Boolean): Member {
        val radio = TrackedRadio(newRadio())
        val link = RadarLink(
            store = LinkStore(serial) { enabledNow },
            radio = radio,
            bluetoothOn = bluetoothOn,
            locationOn = locationOn,
            permissionsGranted = permissionsGranted,
            log = log,
            later = later
        )
        val member = Member(serial, link, radio, paired)
        link.onSpeeds = { pitch, exit -> onSpeeds?.invoke(serial, pitch, exit) }
        members += member
        link.onState = { publish() }
        // A radar only shown is never looked for; its link stays suppressed.
        if (paired) link.start()
        return member
    }

    private fun remove(member: Member) {
        members.remove(member)
        member.link.onState = null
        member.link.onSpeeds = null
        member.link.unpair()
        member.radio.setListener(null)
        member.radio.release()
    }

    private fun applyScan() {
        val want = scanningFlow.value && enabledNow && bluetoothOn() && locationOn() && permissionsGranted()
        if (want && !radioScanning) {
            val radio = scanRadio ?: newRadio().also { scanRadio = it }
            radioScanning = true
            log("RADAR_FLEET_SCAN_START")
            radio.startScan { onAdvertisement(it) }
        } else if (!want && radioScanning) {
            radioScanning = false
            scanRadio?.stopScan()
            log("RADAR_FLEET_SCAN_STOP")
        }
    }

    private fun endScan() {
        scanningFlow.value = false
        nearbyFlow.value = emptyList()
        applyScan()
    }

    private fun onAdvertisement(name: String) {
        if (!scanningFlow.value || !TAG_NAME.containsMatchIn(name) || member(name)?.paired == true) return
        val names = nearbyFlow.value
        if (names.any { it.equals(name, ignoreCase = true) }) return
        nearbyFlow.value = names + name
        publish()
    }

    private fun persist() {
        store.writeSerials(serials)
    }

    private fun publish() {
        devicesFlow.value = members.filter { it.paired }.map { device(it) }
        val first = members.firstOrNull()
        val base = first?.link?.state?.value ?: unpairedState()
        cameramanFlow.value = base.copy(
            enabled = enabledNow,
            pickerOpen = scanningFlow.value,
            pickerNames = nearbyFlow.value
        )
    }

    /** No radar: the switch, Bluetooth and the permission still say what they did with one link. */
    private fun unpairedState(): RadarUiState {
        val decision = LinkPolicy.action(
            serial = null,
            bluetoothOn = bluetoothOn(),
            locationOn = locationOn(),
            permissionsGranted = permissionsGranted(),
            pickerOpen = scanningFlow.value,
            gatt = GattState.Down,
            suppressed = false,
            enabled = enabledNow
        )
        val phase = when (decision.status) {
            LinkPolicy.BLUETOOTH_OFF -> RadarPhase.bluetoothOff
            LinkPolicy.LOCATION_OFF -> RadarPhase.locationOff
            LinkPolicy.PERMISSION -> RadarPhase.permission
            else -> RadarPhase.idle
        }
        return RadarUiState(phase = phase, statusText = decision.status)
    }

    private fun device(member: Member): RadarDeviceState {
        val state = member.link.state.value
        val connection = when {
            !enabledNow -> RadarConnection.off
            state.phase == RadarPhase.connected -> RadarConnection.connected
            state.phase == RadarPhase.connecting ->
                if (member.radio.scanning) RadarConnection.scanning else RadarConnection.connecting
            state.phase == RadarPhase.idle -> RadarConnection.off
            else -> RadarConnection.bluetoothOff
        }
        val pitch = state.board.pitch
        val exit = state.board.exit
        return RadarDeviceState(
            serial = member.serial,
            connection = connection,
            batteryPercent = state.batteryPercent,
            pitchMph = pitch?.mph,
            exitMph = exit?.mph,
            readingAt = listOfNotNull(pitch?.atMs, exit?.atMs).maxOrNull()
        )
    }
}
