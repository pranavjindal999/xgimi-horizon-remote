# Using this on something that is not a Horizon

The remote was built against an XGIMI Horizon (the development unit was a Horizon 20 Max, model `XR16A`, Android 14). The page, the server, YouTube, volume, and the direction pad use ordinary Android TV commands. Those travel to other devices without a code change.

These pieces call XGIMI services and will no-op or error elsewhere:

| Behavior | File |
| --- | --- |
| Brightness, screen on/off, some power paths | `src/projector.mjs` |
| HDMI source list and switching | `src/sources.mjs` |
| How standby is detected from properties | `src/wake.mjs` |
| Which device counts as "the projector" | `src/adb-discover.mjs` and `.env` |

A useful port usually looks like this:

1. Set `XGIMI_HOST` to the other device. Confirm `adb shell input keyevent 19` moves the focus up.
2. Leave the XGIMI display commands alone until you know the replacement. A failing brightness call should not block keys.
3. If the device's YouTube is not `com.google.android.youtube.tv`, the now-playing id from the Cobalt log will not appear. Transport keys still work. The package check lives next to `isYoutubePackage` in `src/controller.mjs`.
4. Rebuild the page only if you change `web/`.

Please keep device-specific addresses out of the code. Put them in `.env`. Pull requests that make another Android TV work, behind a clear name rather than a hardcoded address, are welcome.

## Rebuilding the seek helper

`device/seek.jar` is already built. Rebuild it when you change `device/SeekTo.java`. You need a JDK and Android `android.jar` (API 34 is what this was built with), plus `d8` from the Android build tools.

```bash
cd device
mkdir -p out
javac --release 8 -cp "$ANDROID_JAR" -d out SeekTo.java
d8 --min-api 26 --output out out/com/xgimi/seek/SeekTo.class
jar cf seek.jar -C out classes.dex
```

Set `ANDROID_JAR` to the `android.jar` inside your Android SDK platforms directory. The server picks up `device/seek.jar` the next time a seek runs. Delete `/data/local/tmp/seek.jar` on the device if a stale copy is still there.
