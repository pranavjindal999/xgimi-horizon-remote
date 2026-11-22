# Setup

Horizon Remote is a Node server plus a static page. One machine on the LAN runs it. Phones and laptops only open the page.

## 1. On the projector

1. Connect the projector to the same Wi-Fi or Ethernet LAN as the computer that will run the server.
2. Open Settings → Device preferences → About.
3. Click **Build** until developer options are enabled.
4. Go back, open Developer options, and turn on **USB debugging**.
5. Turn on **Wireless debugging**. Note the IP address and port. The port is usually `5555`.
6. If you want wake-from-standby, also note the Wi-Fi MAC address (Settings → Network, or the router's client list).

The first `adb connect` shows "Allow USB debugging?" on the projector. Choose Allow. Until you do, the device shows as `unauthorized` and the remote cannot talk to it.

Wireless debugging is a local admin channel. Leave it off when you do not want it, and do not forward port 5555 through your router.

## 2. On the computer

Install:

- Node.js 20 or newer
- Android platform-tools, so the `adb` command exists
- OpenSSL, used to create the local HTTPS certificate

From a clone of this repo:

```bash
./scripts/install.sh
```

That command:

- installs the Node dependencies
- builds the page into `web/dist`
- copies `.env.example` to `.env` if you do not already have one
- creates `data/` for history and the certificate

It does not start the server.

## 3. Point it at your projector

Open `.env`.

| Variable | When to set it |
| --- | --- |
| `XGIMI_HOST` | Best option. `192.168.1.50:5555`, using your projector's IP. |
| `XGIMI_MAC` | Use this for wake, and for finding the IP after it changes, if the router still has the MAC in its neighbor table. |
| `XGIMI_SERIAL` | Optional. `adb shell getprop ro.serialno`. The server then ignores other Android devices. |
| `XGIMI_MODEL` | Optional. `adb shell getprop ro.product.model`. A Horizon 20 is often `XR16A`. |
| `ADB_VENDOR_KEYS` | Path to your private ADB key, if it is not `~/.android/adbkey`. |
| `XGIMI_SCAN` | Leave at `0`. Set to `1` only if you want the server to probe the local subnet for port 5555. |

`XGIMI_HOST` is enough. If both host and MAC are empty, the server uses the device only when `adb devices` lists exactly one device.

Check the link:

```bash
./scripts/check.sh
```

## 4. Start it

Foreground, so you can read the log:

```bash
./scripts/run.sh
```

Then open `http://<this-computer>:8095` from a phone or laptop on the same LAN. The port is `PORT` in `.env` (8095 unless you changed it).

Health check: `http://127.0.0.1:8095/api/health`

To keep it running after logout and across reboots:

```bash
sudo ./scripts/install.sh --service
```

That writes `/etc/systemd/system/xgimi-horizon-remote.service` using the Node binary and the directory you installed into, then enables it. Logs:

```bash
journalctl -u xgimi-horizon-remote -f
```

## 5. Install it on a phone

Browsers only allow "Add to Home Screen" on a secure origin. The server can create its own certificate for your LAN addresses.

1. Open `http://<server>:8095/ca.crt` and install that certificate as a trusted CA on the phone.
2. Open `https://<server>:8443`.
3. Use the browser's install / Add to Home Screen action.

The certificate is stored under `data/tls` (or `TLS_DIR`). It is generated for this machine's LAN IPs plus any addresses in `LAN_IP`. If the computer's IP changes, delete `data/tls` and restart so a new certificate is created, then re-trust it on the phone.

If you already publish the page through your own HTTPS (Tailscale Serve, a reverse proxy, and so on), set `PUBLIC_HTTPS_URL` to that origin so the install hint matches it. Do not put that hostname in the git repo. It stays in `.env`.

## 6. Update

```bash
git pull
./scripts/install.sh
```

Restart `./scripts/run.sh`, or `sudo systemctl restart xgimi-horizon-remote` if you used the service. The page is served from `web/dist`, which only updates when the build runs.

## What you should not need to do

- No account, no cloud, no projector firmware change.
- No app installed permanently on the projector. `device/seek.jar` is copied to `/data/local/tmp` the first time you seek, and run for that one command.
- No edit to the source for a normal Horizon on the same LAN.
