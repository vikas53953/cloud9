# Keep-awake helper

A small PowerShell script that stops this Windows PC from **sleeping** while a
long agent run is going. The screen may still dim; the machine stays awake.

## When to use it

Overnight or multi-hour Cloud9 / Cursor work on a laptop that would otherwise
sleep and pause everything.

## How to run

1. Open PowerShell.
2. Go to this repo (or pass the full path to the script).
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\keep-awake.ps1
```

4. Leave that window open. You should see one plain sentence that it is keeping
   the system awake.
5. When you are done, press **Ctrl+C** in that window. Normal sleep behaviour
   comes back.

## What it does (plain words)

Windows has a switch programs can flip that means "please do not sleep the
system right now." This script flips that switch on while it runs, and flips it
off when you stop it (or when the window closes).

It does **not** stop the display from turning off. That is deliberate — only the
system sleep is blocked.

## If it refuses

If PowerShell cannot load the small helper that talks to Windows, the script
prints one plain sentence and exits. Nothing half-applied is left behind.

## Checking it yourself

While the script is running, in another PowerShell window:

```powershell
powercfg /requests
```

You should see a **SYSTEM** request from PowerShell / the script.

After you stop the script, run the same command again — that SYSTEM line should
be gone.
