#import <UIKit/UIKit.h>
#import <React/RCTView.h>

@interface TSChatKeyboardGuideView : UIView
@property(nonatomic, copy) void (^onChatKeyboardInset)(NSDictionary *);
@property(nonatomic, copy) void (^onChatKeyboardRest)(NSDictionary *);
@end

@interface TSChatComposerDockView : RCTView
@property(nonatomic, copy) NSNumber *dockClearance;
@end
