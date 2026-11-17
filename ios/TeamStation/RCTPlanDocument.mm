#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>
#import <UIKit/UIKit.h>

// Hands a game plan PDF in the cache to the system: the share sheet, and
// the print dialog. On an iPad each points at the rectangle the app passes,
// the pressed control's place in the window.
@interface RCTPlanDocument : NativePlanDocumentSpecBase <NativePlanDocumentSpec>
@end

@implementation RCTPlanDocument
RCT_EXPORT_MODULE(TSPlanDocument)

// The controller on top: the foreground scene's key window's root, and
// whatever it presents.
static UIViewController *TopController(void)
{
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive ||
        ![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
      if (candidate.isKeyWindow) {
        window = candidate;
        break;
      }
    }
    if (window != nil) {
      break;
    }
  }
  UIViewController *controller = window.rootViewController;
  while (controller.presentedViewController != nil) {
    controller = controller.presentedViewController;
  }
  return controller;
}

static CGRect AnchorIn(UIView *view, double x, double y, double width, double height)
{
  CGRect rect = CGRectMake(x, y, MAX(width, 1), MAX(height, 1));
  return [view convertRect:rect fromView:nil];
}

RCT_EXPORT_METHOD(share:(NSString *)path
                  x:(double)x
                  y:(double)y
                  width:(double)width
                  height:(double)height
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = TopController();
    NSURL *file = [NSURL fileURLWithPath:path];
    if (controller == nil || controller.isBeingDismissed ||
        ![NSFileManager.defaultManager fileExistsAtPath:path]) {
      reject(@"plan_document", @"Nothing to share from", nil);
      return;
    }
    UIActivityViewController *sheet =
        [[UIActivityViewController alloc] initWithActivityItems:@[ file ] applicationActivities:nil];
    UIPopoverPresentationController *popover = sheet.popoverPresentationController;
    if (popover != nil) {
      popover.sourceView = controller.view;
      popover.sourceRect = AnchorIn(controller.view, x, y, width, height);
    }
    // Settled once asked, as print is: a presentation UIKit declines would
    // never call a completion.
    [controller presentViewController:sheet animated:YES completion:nil];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(print:(NSString *)path
                  jobName:(NSString *)jobName
                  x:(double)x
                  y:(double)y
                  width:(double)width
                  height:(double)height
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = TopController();
    NSURL *file = [NSURL fileURLWithPath:path];
    if (controller == nil || ![UIPrintInteractionController canPrintURL:file]) {
      reject(@"plan_document", @"Nothing to print", nil);
      return;
    }
    UIPrintInfo *info = [UIPrintInfo printInfo];
    info.outputType = UIPrintInfoOutputGeneral;
    info.orientation = UIPrintInfoOrientationPortrait;
    info.jobName = jobName;
    UIPrintInteractionController *printer = UIPrintInteractionController.sharedPrintController;
    printer.printInfo = info;
    printer.printingItem = file;
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
      UIView *view = controller.view;
      [printer presentFromRect:AnchorIn(view, x, y, width, height)
                        inView:view
                      animated:YES
             completionHandler:nil];
    } else {
      [printer presentAnimated:YES completionHandler:nil];
    }
    resolve(nil);
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativePlanDocumentSpecJSI>(params);
}
@end
