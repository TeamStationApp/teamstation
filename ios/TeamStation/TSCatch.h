#import <AVFoundation/AVFoundation.h>

/**
 * Installs the microphone tap on the engine's input, using the bus's own
 * format. Reading the input node before it exists, and `installTap` on a
 * format mismatch, throw NSExceptions Swift cannot catch. Those terminate
 * the app. Returns the exception's reason, or nil when the tap is installed.
 */
#ifdef __cplusplus
extern "C" {
#endif
NSString *_Nullable TSInstallDictationTap(AVAudioEngine *engine,
                                          AVAudioNodeTapBlock tap);
#ifdef __cplusplus
}
#endif
