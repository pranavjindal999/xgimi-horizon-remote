# Agent setup

Follow this file when a person asks you to set up Horizon Remote. The human overview is [README.md](README.md). The long setup notes are [docs/setup.md](docs/setup.md).

## Rules

- Stay on the LAN. Do not port-forward this server or ADB (`5555`) to the internet.
- Do not commit `.env`, ADB keys, `data/`, or TLS files. They are gitignored.
- Do not put a real IP, MAC address, serial number, or hostname into committed files. Those belong in `.env` only.
- Do not change volume, mute, brightness, HDMI input, screen power, or playback unless the person explicitly asks you to test that control.
- Do not shut down or reboot the projector.
- Do not disable the stock launcher or `com.google.android.tungsten.setupwraith`. Setupwraith owns Wi-Fi on some XGIMI builds.
- Prefer the scripts in `scripts/`. Do not hand-roll a second install path.

## Steps

1. Read `.env.example` and `docs/setup.md`.
2. Confirm `node` is 20 or newer and `adb` is on `PATH`. If either is missing, install it with the machine's package manager and stop to say so if you cannot.
3. Run `./scripts/install.sh` from the repo root. That installs dependencies, builds `web/dist`, and creates `.env` when it is missing.
4. Decide how to reach the projector:
   - If the person gave an IP, set `XGIMI_HOST` to `that-ip:5555`.
   - If they gave a Wi-Fi MAC, set `XGIMI_MAC`. The server looks that MAC up in the neighbor table.
   - If neither is known, run `adb devices -l`. When exactly one device is listed, leave `XGIMI_HOST` and `XGIMI_MAC` empty. The server uses that single device.
   - When more than one device is listed, ask which one. Do not guess, and do not turn on `XGIMI_SCAN` unless they asked for a subnet scan.
5. Point `ADB_VENDOR_KEYS` at the private key file when it is not `~/.android/adbkey`.
6. Run `adb connect <XGIMI_HOST>` when a host is set. If the device shows `unauthorized`, tell the person to accept the prompt on the projector, then retry. Do not work around that by copying someone else's key.
7. Run `./scripts/check.sh`. Fix what it reports.
8. Start the server with `./scripts/run.sh`. If they want it on boot and you have permission, run `sudo ./scripts/install.sh --service`.
9. Open `http://127.0.0.1:8095/api/health` and confirm it answers. Tell the person the LAN URL (`http://<this-machine-lan-ip>:8095`).
10. For a phone install, mention `https://<lan-ip>:8443` and that they must trust the certificate from `http://<lan-ip>:8095/ca.crt` first. Leave `PUBLIC_HTTPS_URL` empty unless they already have their own HTTPS front.

## If something fails

- `Projector ADB not found`: wireless debugging is off, the IP changed, or the key was not accepted. Read the server log. Do not scan the whole LAN unless `XGIMI_SCAN=1` was requested.
- The page is blank: `web/dist` was not built. Run `npm run build` from the repo root.
- Brightness, screen, or HDMI fails on a non-XGIMI device: that is expected. Keys, volume, apps, and YouTube still use standard Android commands. See [docs/adapting.md](docs/adapting.md).
- YouTube has no video id: the TV YouTube app is Cobalt (`com.google.android.youtube.tv`). The id is a `Navigated to .../watch?v=` line on the `cobalt` log tag. Other players will not emit that line. The transport controls still work.

## Files you will edit for a normal setup

| File | Touch it? |
| --- | --- |
| `.env` | Yes. This is the only config file. |
| `scripts/install.sh` | No, unless a step is actually broken. |
| `src/` | No, for a stock XGIMI Horizon. |
| `web/` | No, unless they asked for a UI change. |
