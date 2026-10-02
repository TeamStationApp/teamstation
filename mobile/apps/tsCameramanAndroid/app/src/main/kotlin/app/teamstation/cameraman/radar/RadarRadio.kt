package app.teamstation.cameraman.radar

internal interface RadarRadio {
    fun startScan(onName: (String) -> Unit)
    fun stopScan()
    fun connect(name: String)
    fun disconnect()
    fun subscribe(uuid: String)
    fun write(bytes: ByteArray): Int
    fun setListener(listener: RadarRadioListener?)
}

internal interface RadarRadioListener {
    fun onConnected()
    fun onDisconnected()
    fun onNotification(value: ByteArray)
}

/**
 * The production radio's Android calls sit behind these two operations so the methods
 * [AndroidRadarRadio] actually runs are the ones a unit test invokes.
 */
internal class AndroidRadarRadio(
    private val startScanFn: (onName: (String) -> Unit) -> Unit,
    private val stopScanFn: () -> Unit,
    private val connectFn: (String) -> Unit,
    private val disconnectFn: () -> Unit,
    private val subscribeFn: (String) -> Unit,
    private val writeFn: (ByteArray) -> Int,
    private val listenerFn: (RadarRadioListener?) -> Unit
) : RadarRadio {
    override fun startScan(onName: (String) -> Unit) = startScanFn(onName)
    override fun stopScan() = stopScanFn()
    override fun connect(name: String) = connectFn(name)
    override fun disconnect() = disconnectFn()
    override fun subscribe(uuid: String) = subscribeFn(uuid)
    override fun write(bytes: ByteArray): Int = writeFn(bytes)
    override fun setListener(listener: RadarRadioListener?) = listenerFn(listener)
}
