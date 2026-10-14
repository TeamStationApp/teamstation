#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

/**
 * `TSCameraGeometry` in AppDelegate.swift, declared by hand: the generated
 * Swift header also declares the app delegate, whose Objective-C superclass
 * an Objective-C++ file cannot import as a module.
 */
@interface TSCameraGeometry : NSObject
+ (void)lockLandscape;
+ (void)allowRotation;
+ (void)lockPortrait;
@end

@interface RCTCameraOrientation : NSObject <RCTBridgeModule>
@end

@implementation RCTCameraOrientation

RCT_EXPORT_MODULE(TSOrientation)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

RCT_EXPORT_METHOD(lockLandscape)
{
  [TSCameraGeometry lockLandscape];
}

RCT_EXPORT_METHOD(allowRotation)
{
  [TSCameraGeometry allowRotation];
}

RCT_EXPORT_METHOD(lockPortrait)
{
  [TSCameraGeometry lockPortrait];
}

@end
