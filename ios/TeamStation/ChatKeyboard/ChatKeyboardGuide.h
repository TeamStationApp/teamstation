#import <UIKit/UIKit.h>

@interface TSChatKeyboardGuideView : UIView
@property(nonatomic, copy) void (^onChatKeyboardInset)(NSDictionary *);
@property(nonatomic, copy) void (^onChatKeyboardRest)(NSDictionary *);
@end
