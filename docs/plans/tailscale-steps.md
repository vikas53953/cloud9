# Tailscale setup — click-by-click (PC + phone)

Goal: put this Windows PC and your phone on the same private Tailscale network (a “tailnet”), so they can reach each other by a `100.x.x.x` address even when you are not on the same Wi‑Fi.

You do **not** need to change router settings. Free personal account is enough.

---

## A. Create a Tailscale account (once)

1. On the PC, open a browser.
2. Go to: https://login.tailscale.com/start
3. Click **Get started**.
4. Sign in with Google, Microsoft, GitHub, or Apple (pick one you already use).
5. Finish any “welcome / create network” screens until you see the Tailscale admin page (devices list). Leave this tab open.

---

## B. Install Tailscale on the Windows PC

1. Go to: https://tailscale.com/download/windows
2. Click **Download**.
3. Open the downloaded installer (usually in your Downloads folder; name like `Tailscale-Setup-….exe`).
4. If Windows asks “Do you want to allow this app…?”, click **Yes**.
5. Click through the installer with the defaults (**Next** / **Install** / **Finish**).
6. When install finishes, Tailscale should open a small window or tray icon (look near the clock, bottom-right).
7. If you do not see the icon, click the `^` chevron in the system tray to show hidden icons.

### Sign the PC into your tailnet

8. Click the Tailscale tray icon.
9. Click **Log in** (or **Sign in**).
10. A browser tab opens — sign in with the **same account** from section A.
11. If asked to authorize this device, click **Connect** / **Authorize**.
12. Back at the tray icon: it should show you are connected (often a green/connected state).
13. Click the tray icon again and look for your machine name and an IP that starts with **100.** (example: `100.64.1.23`). That is this PC’s Tailscale address.

### Optional check from the admin page

14. Return to https://login.tailscale.com/admin/machines
15. Confirm this PC appears in the list as **Connected**.

---

## C. Install Tailscale on your phone

### iPhone / iPad

1. Open the **App Store**.
2. Search for **Tailscale**.
3. Tap **Get** / **Install** on the app by Tailscale Inc.
4. Open the **Tailscale** app.
5. Tap **Get Started** / **Log in**.
6. Sign in with the **same account** as the PC.
7. Allow VPN configuration when iOS asks (**Allow** / enter passcode or Face ID).
8. In the app, turn the connection **On** (toggle).
9. Confirm the phone shows as connected and note its **100.** address if shown.
10. On the PC admin page (https://login.tailscale.com/admin/machines), confirm the phone appears as **Connected**.

### Android

1. Open the **Play Store**.
2. Search for **Tailscale**.
3. Tap **Install** on the app by Tailscale Inc.
4. Open the **Tailscale** app.
5. Tap **Get Started** / **Log in**.
6. Sign in with the **same account** as the PC.
7. When Android asks to set up a VPN connection, tap **OK** / **Allow**.
8. In the app, turn Tailscale **On**.
9. Confirm connected status and note the **100.** address if shown.
10. On the PC admin page, confirm the phone appears as **Connected**.

---

## D. Quick “are we on the same network?” check

1. On the PC, open PowerShell.
2. From the Cloud9 lane-T folder (or wherever this repo is), run:

   ```powershell
   .\scripts\check-network.ps1
   ```

3. Read the plain-English lines. You want something like:
   - Tailscale is installed
   - You are signed in / connected
   - This machine’s Tailscale address is `100.…`

4. On the phone Tailscale app (or admin machines list), confirm the phone also has a `100.…` address under the **same** account.
5. Optional later: from the phone browser or ping tools, try reaching the PC’s `100.…` address for services you expose on purpose. Do not open random ports unless you mean to.

---

## E. Common snags

| What you see | What to do |
|---|---|
| Tray icon missing after install | Reboot once, or start **Tailscale** from the Start menu |
| Browser login never finishes | Use the same browser profile; disable strict blockers for `login.tailscale.com` for that step |
| Phone and PC on different accounts | Log out in the phone app and log in with the PC’s account |
| PC shows Logged out | Tray icon → **Log in** again |
| Checker says Tailscale is not installed | Finish section B, then re-run the script |

---

## F. What this does **not** do

- Does not replace your home Wi‑Fi for normal browsing.
- Does not automatically expose Cloud9 or other apps to the internet.
- Does not change Windows firewall rules by itself beyond Tailscale’s own VPN adapter.
- The checker script in this repo is **read-only**: it only reports status; it never installs, logs in, or restarts anything.
