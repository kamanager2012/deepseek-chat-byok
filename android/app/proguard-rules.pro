-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.deepseekbyok.app.MainActivity$ExportBridge {
    *;
}
-keepclassmembers class com.deepseekbyok.app.LocalBridgeServer {
    public *;
}
-keepattributes *Annotation*
