/* Lane E AFTER measurement, part F: re-read the Chat + Files close button after
   the one repair this verification added. Throwaway harness. */
async (page) => {
  const HELPERS = `
    const parse = (value) => { const m = value.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const mix = (fg, bg) => fg.a >= 1 ? fg : ({ r: fg.r*fg.a+bg.r*(1-fg.a), g: fg.g*fg.a+bg.g*(1-fg.a), b: fg.b*fg.a+bg.b*(1-fg.a), a: 1 });
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100; };
    const overBg = (el) => { let n = el; while (n) { const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.05) return bg; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const hex = (c) => c ? "#" + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase() : null;
    const readInk = (el) => { const cs = getComputedStyle(el); const bg = overBg(el);
      let fg = parse(cs.color); const a = Number(cs.opacity);
      if (fg && a < 1) fg = { r: fg.r, g: fg.g, b: fg.b, a: fg.a * a };
      const shown = fg ? mix(fg, bg) : null;
      return { ink: hex(fg), on: hex(bg), opacity: cs.opacity, contrast: shown ? ratio(shown, bg) : null }; };
  `;
  const freeze = () => page.addStyleTag({ content: "*,*::before,*::after{transition:none !important;animation:none !important;}" }).catch(() => {});
  const out = [];
  await page.setViewportSize({ width: 1680, height: 1000 });
  for (const [os, mode, palette] of [
    ["dark", "system", "cloud9-pine"], ["dark", "dark", "nord"], ["dark", "dark", "dracula"],
    ["dark", "dark", "high-contrast-dark"], ["dark", "light", "cloud9-pine"],
    ["light", "system", "cloud9-pine"], ["light", "light", "daylight"], ["light", "dark", "nord"],
  ]) {
    await page.emulateMedia({ colorScheme: os });
    await page.evaluate(([m, p]) => {
      const raw = JSON.parse(localStorage.getItem("cloud9.prefs") || "{}");
      raw.appearanceMode = m; raw.palette = p; raw.workspaceLayout = "chat-files";
      localStorage.setItem("cloud9.prefs", JSON.stringify(raw));
    }, [mode, palette]);
    await page.reload();
    await page.waitForSelector('.rail-btn[aria-current="true"]', { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.locator('.rail-btn[title="Home"]').first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    const sel = page.locator(".chathead select").first();
    if (await sel.count()) { await sel.selectOption("chat-files").catch(() => {}); await page.waitForTimeout(600); }
    await freeze();
    out.push({ os, mode, palette, ...await page.evaluate(new Function(HELPERS + `
      const el = document.querySelector(".workspace-layout-close");
      const dis = Array.from(document.querySelectorAll("button")).find(b => b.disabled && b.offsetParent);
      return { theme: document.documentElement.getAttribute("data-theme"),
               closeBtn: el && el.offsetParent ? readInk(el) : { absent: true },
               disabledNorm: dis ? readInk(dis) : { absent: true } };
    `)) });
  }
  return JSON.stringify(out);
}
