#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor's bridge.
CAP_PLUGIN(TripLinkNativePlugin, "TripLinkNative",
  CAP_PLUGIN_METHOD(enqueueUpload, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(pending, CAPPluginReturnPromise);
)
