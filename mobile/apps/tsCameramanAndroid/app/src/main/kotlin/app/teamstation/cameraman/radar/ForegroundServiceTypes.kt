package app.teamstation.cameraman.radar

internal enum class ServiceTypeName {
    Camera,
    Microphone,
    ConnectedDevice,
    Location
}

internal object ForegroundServiceTypes {
    fun names(microphone: Boolean, radarGranted: Boolean): Set<ServiceTypeName> {
        val types = linkedSetOf(ServiceTypeName.Camera)
        if (microphone) types += ServiceTypeName.Microphone
        if (radarGranted) {
            types += ServiceTypeName.ConnectedDevice
            types += ServiceTypeName.Location
        }
        return types
    }
}
