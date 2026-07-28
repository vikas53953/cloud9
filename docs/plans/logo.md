# The Cloud9 logo — how to put it in the app

Written for whoever owns `apps/desktop/src/App.tsx` and `styles.css`. I did not
touch either file. Everything below is ready to use.

## The one asset you need

```
apps/desktop/public/logo.svg
```

Vite serves `public/` at the site root and copies it into `dist-web/` on build,
so the URL is the same in dev and in the packaged app:

```
/logo.svg
```

Use the SVG, not a PNG — it is sharp on any monitor and it is one HTTP-free file.
(The PNGs next to it, `logo-16…512.png` and `icon.ico`, are for Windows and the
favicon. Nothing in React should reference them.)

## The top-bar lockup

The mark sits to the left of the word "Cloud9". The word is set in the Studio
display face and its **9 is marigold**.

```jsx
<span className="c9-lockup">
  <img src="/logo.svg" alt="" className="c9-mark" width={26} height={26} />
  <span className="c9-word">Cloud<b>9</b></span>
</span>
```

```css
.c9-lockup { display: inline-flex; align-items: center; line-height: 1; }
.c9-mark   { flex: none; display: block; width: 26px; height: 26px; }
.c9-word {
  font-family: var(--display);      /* Constantia / Iowan Old Style stack */
  font-weight: 600;
  font-size: 20.5px;                /* 0.79 x mark */
  letter-spacing: -0.015em;
  margin-left: 8.8px;               /* 0.34 x mark */
  transform: translateY(0.5px);     /* 0.02 x mark — optical, see below */
  color: var(--ink);
  white-space: nowrap;
}
.c9-word b { font-weight: 600; color: var(--marigold); }
```

**Intended size in the top bar: a 26px mark.** That gives a 20.5px word, which
sits comfortably against the Studio top bar's 19px `h2`.

## The spacing rules

Everything is a fraction of **M**, the mark's height. Change M and the rest follows.

| Rule | Value |
| --- | --- |
| Gap, plate's right edge to the "C" | 0.34 × M |
| Word size | 0.79 × M |
| Word weight / tracking | 600 / −0.015em |
| Vertical alignment | centre the word's cap-height on the plate's centre, then nudge it **down** 0.02 × M |
| Clear space around the lockup | 0.5 × M on all four sides — no other element enters it |
| Smallest lockup | 20px mark. Below that, drop the word and show the plate alone. |
| The 9 | always marigold; "Cloud" stays in ink |

Why the downward nudge: "Cloud9" has no descenders, so `align-items: center`
centres the whole line box and leaves the word sitting visibly high. The 0.02 × M
push puts the cap-height block back on the plate's optical centre.

## Do not

- Do not recolour the mark, put it on a coloured chip, or add a ring or shadow —
  it already carries its own plate.
- Do not stretch it. It is square; keep it square.
- Do not use it as an agent avatar. It is the studio's own plate, not a crew
  member's — the portrait generator handles those.

## Already wired (not your job)

- Favicon and apple-touch icon — `apps/desktop/index.html`
- Electron window + taskbar icon — `apps/desktop/electron/main.cjs` (`appIconPath()`)
- Installer and shortcut icons — `apps/desktop/package.json` (`build.win.icon`)

To regenerate every raster after an SVG change: `npm run logo -w @cloud9/desktop`
