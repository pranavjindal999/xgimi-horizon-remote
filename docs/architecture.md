# How it fits together

Three places are involved. Only one of them runs this project's server.

## The browser

`web/` is a React page. `npm run build` writes it to `web/dist`, and the server serves those files.

The page opens a WebSocket at `/ws`. The first message is the whole snapshot: power, volume, now playing, apps, suggestions. Later messages are changes. A browser never becomes the source of truth. If two phones are open, both render what the server last published.

The page does load thumbnail image files from `i.ytimg.com`. That is the picture only. Search, related videos, and the video id lookup happen on the server.

## The server

`src/server.mjs` starts with Node. It listens on `PORT` (HTTP) and, when OpenSSL is available, `HTTPS_PORT`.

On startup it begins a one-second read of the projector, even when no browser is connected, and a slower refresh of the app list. Direction keys use their own queue so they are not stuck behind that read.

`src/controller.mjs` is the session: connect, keys, volume, YouTube, seek, wake. `src/projector.mjs` is the XGIMI command set (display service, power, the strings the device understands). `src/adb-discover.mjs` turns `.env` into an `ip:5555` address.

YouTube on Android TV is the Cobalt app, package `com.google.android.youtube.tv`. Its media session has a title and a duration, but not a video id. The id is in logcat, tag `cobalt`, on a line like:

```text
Navigated to https://www.youtube.com/tv#/watch?v=VIDEO_ID
```

The server follows that tag with `adb logcat -T 1 cobalt:I *:S`. It does not replay old lines, and it does not read the app's private files. When the id changes, the server looks up the title and the suggested list, then pushes both to the browsers.

History and starred videos are JSON files in `data/`.

## The projector

The server sends normal `adb shell` commands: `input keyevent`, `media`, settings, and package launches.

Seek uses `device/seek.jar`. The server copies it to `/data/local/tmp/seek.jar` if it is not there, then runs it once with `app_process`. The jar asks the current media session to seek, or prints the position. It is not installed as an app and it does not stay running.

Wake sends a Wake-on-LAN magic packet to `XGIMI_MAC`, then waits until ADB answers. That works from standby on a Horizon when the Wi-Fi stays up. It does not work after a full shutdown. The power button on the projector is the way back from a full shutdown.

## What is Horizon-specific

Generic Android TV:

- keys, volume, media session, app launches, YouTube log follow, seek jar

XGIMI Horizon (see `src/projector.mjs`, `src/sources.mjs`, `src/wake.mjs`):

- brightness and the Boost step
- screen blanking through `xgimi.hardware.gmpf.IDisplayManager`
- HDMI source switching
- the standby property checks used to tell "asleep" from "ADB is just down"

If a command is missing on another device, that control fails and the rest of the remote still runs. [docs/adapting.md](adapting.md) lists the files to change.
