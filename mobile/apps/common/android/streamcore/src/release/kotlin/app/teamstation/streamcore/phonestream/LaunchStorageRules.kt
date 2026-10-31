package app.teamstation.streamcore.phonestream

/** The rules this process runs by. Debug builds can move the start floor; release builds cannot. */
internal fun launchStorageRules(): PhoneStorageRules = PhoneStorageRules.standard
