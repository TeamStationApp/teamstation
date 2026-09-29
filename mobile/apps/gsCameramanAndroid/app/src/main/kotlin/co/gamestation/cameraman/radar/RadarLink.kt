package co.gamestation.cameraman.radar

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal interface RadarPairingStore {
    fun read(): String?
    fun write(serial: String?)
    fun readEnabled(): Boolean = true
    fun writeEnabled(enabled: Boolean) = Unit
}

/**
 * Applies [LinkPolicy] to [RadarRadio] and publishes what settings and the viewfinder draw.
 * A uiTest feed sets [RadarUiState.linkSuppressed] so the radio stays idle while the board shows
 * the fed clock.
 */
internal class RadarLink(
    private val store: RadarPairingStore,
    private val radio: RadarRadio,
    private val bluetoothOn: () -> Boolean,
    private val locationOn: () -> Boolean,
    private val permissionsGranted: () -> Boolean,
    private val log: (String) -> Unit,
    private val later: (Long, () -> Unit) -> Unit = { delayMs, block ->
        Handler(Looper.getMainLooper()).postDelayed(block, delayMs)
    }
) : RadarRadioListener {
    private val mutable = MutableStateFlow(RadarUiState())
    val state: StateFlow<RadarUiState> = mutable.asStateFlow()

    private var serial: String? = null
    private var gatt = GattState.Down
    private var scanning = false
    private var suppressed = false
    private val handshake = Handshake()
    private var loggedIdle = false
    private var session = 0
    private var dropsSinceLive = 0
    private var enabled = true

    fun start() {
        serial = RadarPairingRecord.serialFrom(store.read())
        enabled = store.readEnabled()
        radio.setListener(this)
        refresh()
        if (!scanning) noteIdle()
    }

    fun setEnabled(on: Boolean) {
        enabled = on
        store.writeEnabled(on)
        if (!on) {
            session += 1
            if (gatt != GattState.Down) {
                gatt = GattState.Down
                radio.disconnect()
            }
            stopScan()
        }
        refresh()
    }

    fun openPicker() {
        mutable.value = mutable.value.copy(pickerOpen = true, pickerNames = emptyList())
        refresh()
    }

    fun dismissPicker() {
        mutable.value = mutable.value.copy(pickerOpen = false)
        refresh()
    }

    fun pair(name: String) {
        val saved = RadarPairingRecord.serialFrom(name) ?: return
        session += 1
        serial = saved
        store.write(saved)
        suppressed = false
        mutable.value = mutable.value.copy(pickerOpen = false, serial = saved, linkSuppressed = false)
        refresh()
    }

    fun unpair() {
        session += 1
        serial = null
        suppressed = false
        store.write(null)
        gatt = GattState.Down
        radio.disconnect()
        stopScan()
        mutable.value = RadarUiState(enabled = enabled)
        noteIdle()
    }

    fun show(command: RadarCommand.Show) {
        session += 1
        suppressed = true
        stopScan()
        mutable.value = mutable.value.copy(
            serial = command.serial,
            phase = command.phase,
            connectingStep = command.step,
            linkSuppressed = true,
            pickerOpen = false,
            statusText = statusFor(command.phase)
        )
    }

    fun setStep(step: Int) {
        if (suppressed) return
        mutable.value = mutable.value.copy(connectingStep = step)
    }

    fun feed(command: RadarCommand.Feed) {
        session += 1
        suppressed = true
        stopScan()
        val board = mutable.value.board.receive(command.pitch, command.exit, command.now)
        mutable.value = mutable.value.copy(board = board, linkSuppressed = true)
    }

    fun onAdvertisement(name: String) {
        if (!TAG_NAME.containsMatchIn(name)) return
        val names = mutable.value.pickerNames
        if (mutable.value.pickerOpen && names.none { it.equals(name, ignoreCase = true) }) {
            mutable.value = mutable.value.copy(pickerNames = names + name)
        }
        if (LinkPolicy.acceptsScanResult(serial, name) && gatt == GattState.Down) {
            gatt = GattState.Connecting
            stopScan()
            radio.connect(name)
            refresh()
        }
    }

    override fun onConnected() {
        session += 1
        gatt = GattState.Up
        apply(handshake.start(), session)
        refresh()
    }

    override fun onDisconnected() {
        if (gatt == GattState.Down) return
        session += 1
        val reconnect = serial != null && !suppressed
        gatt = GattState.Down
        handshake.onDisconnected()
        if (reconnect && bluetoothOn() && locationOn() && permissionsGranted()) {
            dropsSinceLive += 1
            gatt = GattState.Connecting
            val delay = LinkPolicy.reconnectDelayMs(dropsSinceLive)
            val token = session
            later(delay) {
                if (token != session || gatt != GattState.Connecting) return@later
                gatt = GattState.Down
                refresh()
            }
        }
        refresh()
    }

    override fun onNotification(value: ByteArray) {
        if (suppressed) return
        val battery = RadarProtocol.batteryPercent(value)
        if (battery != null) {
            mutable.value = mutable.value.copy(batteryPercent = battery)
            return
        }
        val frame = RadarProtocol.parseRadar(value)
        if (frame is RadarFrame.Speed) {
            val speeds = RadarProtocol.pitchExit(frame.signedCms, frame.extraCms)
            val now = System.currentTimeMillis()
            val board = mutable.value.board.receive(speeds.pitchMph, speeds.exitMph, now)
            mutable.value = mutable.value.copy(board = board)
        }
    }

    fun refresh() {
        val decision = LinkPolicy.action(
            serial = serial,
            bluetoothOn = bluetoothOn(),
            locationOn = locationOn(),
            permissionsGranted = permissionsGranted(),
            pickerOpen = mutable.value.pickerOpen,
            gatt = gatt,
            suppressed = suppressed,
            enabled = enabled
        )
        when (decision.action) {
            LinkAction.Idle -> {
                stopScan()
                if (gatt != GattState.Down) {
                    radio.disconnect()
                    gatt = GattState.Down
                }
            }
            LinkAction.Hold -> stopScan()
            LinkAction.ScanPicker, LinkAction.ScanSerial -> startScan()
        }
        if (suppressed) return
        val phase = when {
            decision.status == LinkPolicy.BLUETOOTH_OFF -> RadarPhase.bluetoothOff
            decision.status == LinkPolicy.LOCATION_OFF -> RadarPhase.locationOff
            decision.status == LinkPolicy.PERMISSION -> RadarPhase.permission
            gatt == GattState.Up -> RadarPhase.connected
            serial != null && decision.action != LinkAction.Idle -> RadarPhase.connecting
            else -> RadarPhase.idle
        }
        mutable.value = mutable.value.copy(
            serial = serial,
            phase = phase,
            linkSuppressed = false,
            enabled = enabled,
            statusText = decision.status ?: statusFor(phase)
        )
    }

    private fun apply(effect: HandshakeEffect, token: Int) {
        if (token != session || gatt != GattState.Up) return
        when (effect) {
            is HandshakeEffect.Subscribe -> {
                effect.uuids.forEach { radio.subscribe(it) }
                apply(handshake.onSubscribed(), token)
            }
            is HandshakeEffect.Write -> {
                val status = radio.write(effect.bytes)
                val next = handshake.onWriteFinished(status)
                if (status == 201) later(RETRY_MS) { apply(next, token) }
                else apply(next, token)
            }
            is HandshakeEffect.Wait -> later(effect.ms) {
                if (token == session && gatt == GattState.Up) {
                    apply(handshake.onPaceElapsed(), token)
                }
            }
            HandshakeEffect.Live -> {
                dropsSinceLive = 0
                later(Handshake.KEEPALIVE_MS) {
                    if (token == session && gatt == GattState.Up) {
                        apply(handshake.onTick(Handshake.KEEPALIVE_MS), token)
                    }
                }
            }
            HandshakeEffect.Dropped -> onDisconnected()
        }
    }

    private fun startScan() {
        if (scanning) return
        scanning = true
        loggedIdle = false
        log("RADAR_SCAN_START")
        radio.startScan { onAdvertisement(it) }
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        radio.stopScan()
        log("RADAR_SCAN_STOP")
    }

    private fun noteIdle() {
        if (loggedIdle) return
        loggedIdle = true
        log("RADAR_IDLE")
    }

    private fun statusFor(phase: RadarPhase): String? = when (phase) {
        RadarPhase.bluetoothOff -> LinkPolicy.BLUETOOTH_OFF
        RadarPhase.locationOff -> LinkPolicy.LOCATION_OFF
        RadarPhase.permission -> LinkPolicy.PERMISSION
        RadarPhase.connecting -> ConnectionLabel.connecting(mutable.value.connectingStep)
        RadarPhase.connected -> "Connected"
        RadarPhase.idle -> null
    }

    private companion object {
        const val RETRY_MS = 250L
    }
}
