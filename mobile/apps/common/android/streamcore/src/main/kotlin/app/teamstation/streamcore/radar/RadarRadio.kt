package app.teamstation.streamcore.radar

interface RadarRadio {
    fun startScan(onName: (String) -> Unit)
    fun stopScan()
    fun connect(name: String)
    fun disconnect()
    fun subscribe(uuid: String)
    fun write(bytes: ByteArray): Int
    fun setListener(listener: RadarRadioListener?)

    /** The radio is done with: its scan, its GATT client and its thread go. */
    fun release() = Unit
}

interface RadarRadioListener {
    fun onConnected()
    fun onDisconnected()
    fun onNotification(value: ByteArray)
}

/**
 * The production radio's Android calls sit behind these two operations so the methods
 * [AndroidRadarRadio] actually runs are the ones a unit test invokes.
 */
class AndroidRadarRadio(
    private val startScanFn: (onName: (String) -> Unit) -> Unit,
    private val stopScanFn: () -> Unit,
    private val connectFn: (String) -> Unit,
    private val disconnectFn: () -> Unit,
    private val subscribeFn: (String) -> Unit,
    private val writeFn: (ByteArray) -> Int,
    private val listenerFn: (RadarRadioListener?) -> Unit,
    private val releaseFn: () -> Unit = {}
) : RadarRadio {
    override fun startScan(onName: (String) -> Unit) = startScanFn(onName)
    override fun stopScan() = stopScanFn()
    override fun connect(name: String) = connectFn(name)
    override fun disconnect() = disconnectFn()
    override fun subscribe(uuid: String) = subscribeFn(uuid)
    override fun write(bytes: ByteArray): Int = writeFn(bytes)
    override fun setListener(listener: RadarRadioListener?) = listenerFn(listener)
    override fun release() = releaseFn()
}
