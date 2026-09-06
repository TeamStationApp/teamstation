package co.gamestation.cameraman.core

enum class CameraPosition(val rawValue: String) {
    BACK("back"),
    FRONT("front");

    companion object {
        fun fromRawValue(value: String): CameraPosition? =
            entries.firstOrNull { it.rawValue == value }
    }
}
