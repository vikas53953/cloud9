/* Lane E AFTER measurement, part E — the settled pass.
   CSS transitions are switched off before every reading: a headless page that
   never gets focus can leave a transitioning colour parked at its start value,
   which made the Send button read as `--sunk` while the pixels were `--pine`.
   Everything here is therefore the settled, painted colour. Throwaway harness. */
async (page) => {
  const HELPERS = `
    const parse = (value) => {
      const m = value.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    };
    const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const mix = (fg, bg) => fg.a >= 1 ? fg : ({
      r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const ratio = (a, b) => { const la = lum(a), lb = lum(b);
      return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100; };
    const overBg = (el) => { let node = el;
      while (node) { const bg = parse(getComputedStyle(node).backgroundColor); if (bg && bg.a > 0.05) return bg; node = node.parentElement; }
      return { r: 255, g: 255, b: 255, a: 1 }; };
    const hex = (c) => c ? "#" + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase() : null;
    const readInk = (el) => {
      const cs = getComputedStyle(el);
      const bg = overBg(el);
      let fg = parse(cs.color);
      const alpha = Number(cs.opacity);
      if (fg && alpha < 1) fg = { r: fg.r, g: fg.g, b: fg.b, a: fg.a * alpha };
      const shown = fg ? mix(fg, bg) : null;
      return { ink: hex(fg), on: hex(bg), opacity: cs.opacity, contrast: shown ? ratio(shown, bg) : null };
    };
  `;
  const evalIn = (body, arg) => page.evaluate(new Function("arg", HELPERS + body), arg);
  const wait = (ms) => page.waitForTimeout(ms);
  const freeze = () => page.addStyleTag({ content: "*,*::before,*::after{transition:none !important;animation:none !important;}" }).catch(() => {});

  const scenario = async (os, mode, palette) => {
    await page.emulateMedia({ colorScheme: os });
    await page.evaluate(([m, p]) => {
      const raw = JSON.parse(localStorage.getItem("cloud9.prefs") || "{}");
      raw.appearanceMode = m; raw.palette = p; raw.workspaceLayout = "chat-files";
      localStorage.setItem("cloud9.prefs", JSON.stringify(raw));
    }, [mode, palette]);
    await page.reload();
    await page.waitForSelector('.rail-btn[aria-current="true"]', { timeout: 20000 });
    await wait(500);
    await freeze();
  };

  const goHome = async () => {
    await page.locator('.rail-btn[title="Home"]').first().click({ timeout: 6000 }).catch(() => {});
    await wait(400);
    const sel = page.locator(".chathead select").first();
    if (await sel.count()) {
      const value = await sel.inputValue().catch(() => "");
      if (value !== "chat-files") { await sel.selectOption("chat-files").catch(() => {}); await wait(500); }
    }
    await freeze();
  };

  const results = [];
  await page.setViewportSize({ width: 1680, height: 1000 });

  for (const [os, mode, palette] of [
    ["dark", "system", "cloud9-pine"],
    ["dark", "dark", "nord"],
    ["dark", "dark", "dracula"],
    ["dark", "dark", "high-contrast-dark"],
    ["dark", "light", "cloud9-pine"],
    ["light", "system", "cloud9-pine"],
    ["light", "dark", "nord"],
  ]) {
    await scenario(os, mode, palette);
    const entry = { os, askedMode: mode, askedPalette: palette };
    entry.attrs = await page.evaluate(() => ({
      appearance: document.documentElement.getAttribute("data-appearance"),
      theme: document.documentElement.getAttribute("data-theme"),
    }));
    entry.tokens = await page.evaluate(() => {
      const r = getComputedStyle(document.documentElement); const t = (n) => r.getPropertyValue(n).trim();
      return { bg: t("--bg"), line: t("--line"), pine: t("--pine"), onPine: t("--on-pine"),
               railSelectedBg: t("--rail-selected-bg"), railSelectedText: t("--rail-selected-text") };
    });

    await goHome();
    const box = page.locator(".composer-box textarea").first();
    if (await box.count()) { await box.fill("readability probe").catch(() => {}); await wait(400); await freeze(); }
    entry.settled = await evalIn(`
      const one = (selector, name) => { const el = document.querySelector(selector);
        return (!el || !el.offsetParent) ? { name, absent: true } : { name, ...readInk(el) }; };
      const send = Array.from(document.querySelectorAll("button.primary")).find(b => !b.disabled && b.offsetParent);
      const rows = [];
      if (send) { const cs = getComputedStyle(send);
        rows.push({ name: "PRIMARY send button (enabled)", ink: hex(parse(cs.color)), on: hex(parse(cs.backgroundColor)),
                    opacity: cs.opacity, contrast: ratio(parse(cs.color), parse(cs.backgroundColor)) }); }
      else rows.push({ name: "PRIMARY send button (enabled)", absent: true });
      rows.push(one(".chathead select", "workspace-mode selector"));
      rows.push(one(".chathead .header-members", "members chip label"));
      rows.push(one(".chathead .header-members span", "members COUNT"));
      rows.push(one(".workspace-layout-panel", "Chat+Files panel body"));
      for (const el of Array.from(document.querySelectorAll(".workspace-layout-panel button, .workspace-layout-panel select, .iconbtn.workspace-menu, .iconbtn.workspace-new, .iconbtn.workspace-agent, .iconbtn.workspace-layout-close"))) {
        if (!el.offsetParent) continue;
        rows.push({ name: "files-area control: " + (el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 26),
                    cls: String(el.className).slice(0, 34), ...readInk(el) });
      }
      const dis = Array.from(document.querySelectorAll("button")).find(b => b.disabled && b.offsetParent);
      if (dis) rows.push({ name: "DISABLED NORM: " + (dis.getAttribute("aria-label") || dis.title || "").trim().slice(0, 16), ...readInk(dis) });
      return rows;
    `);
    if (await box.count()) await box.fill("").catch(() => {});

    /* Click every sidebar row, then every rail item. */
    entry.sidebarClicks = [];
    const rows = page.locator(".sidebar .side-item, .sidebar .agentrow");
    const rowCount = await rows.count();
    for (let i = 0; i < Math.min(rowCount, 8); i++) {
      const target = rows.nth(i);
      const label = ((await target.textContent().catch(() => "")) || "").trim().slice(0, 20);
      const clickable = await target.isVisible().catch(() => false);
      if (!clickable) { entry.sidebarClicks.push({ clicked: label, note: "not a clickable destination in this layout" }); continue; }
      try { await target.click({ timeout: 6000 }); } catch { entry.sidebarClicks.push({ clicked: label, note: "CLICK FAILED" }); continue; }
      await wait(350); await freeze();
      entry.sidebarClicks.push(await evalIn(`
        const el = document.querySelector('.sidebar .side-item[aria-current="true"], .sidebar .agentrow[aria-current="true"]');
        return el ? { clicked: arg, nowCurrent: el.textContent.trim().slice(0, 20), ...readInk(el) }
                  : { clicked: arg, note: "nothing in the sidebar reads as current" };
      `, label));
    }

    entry.railClicks = [];
    const titles = await page.$$eval(".rail-btn[aria-current]", els => els.map(e => e.getAttribute("title")));
    for (const title of titles) {
      const target = page.locator(`.rail-btn[title="${title}"]`).first();
      try { await target.click({ timeout: 6000 }); } catch { entry.railClicks.push({ clicked: title, note: "CLICK FAILED" }); continue; }
      await wait(380); await freeze();
      entry.railClicks.push(await evalIn(`
        const el = document.querySelector('.rail-btn[aria-current="true"]');
        return el ? { clicked: arg, nowCurrent: el.getAttribute("title"), ...readInk(el) }
                  : { clicked: arg, note: "NOTHING reads as current after the click" };
      `, title));
      await page.keyboard.press("Escape").catch(() => {});
      await wait(120);
    }

    await page.locator('.rail-btn[title="Activity"]').first().click({ timeout: 6000 }).catch(() => {});
    await wait(650); await freeze();
    entry.tabs = await evalIn(`
      const p = document.querySelector('.seg button[aria-pressed="true"]');
      const u = document.querySelector('.seg button[aria-pressed="false"]');
      return { selected: p ? { label: p.textContent.trim().slice(0, 14), ...readInk(p) } : { absent: true },
               unselected: u ? { label: u.textContent.trim().slice(0, 14), ...readInk(u) } : { absent: true } };
    `);
    results.push(entry);
  }
  return JSON.stringify(results);
}
