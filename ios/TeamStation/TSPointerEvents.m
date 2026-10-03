#import <React/RCTConstants.h>

/**
 * W3C pointer events, which React Native leaves off.
 *
 * The dictation button is the web control: it listens for `onPointerDown`.
 * Without this the iPhone never delivers those events, so the button draws
 * and does nothing when it is held. The flag is read when the surface's
 * touch handler is created, which is after `+load`.
 */
@interface TSPointerEvents : NSObject
@end

@implementation TSPointerEvents

+ (void)load
{
  RCTSetDispatchW3CPointerEvents(YES);
}

@end
