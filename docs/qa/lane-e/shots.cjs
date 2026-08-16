/* Lane E: the AFTER rail screenshots that pair with the author's before-*.png. */
async (page) => {
  const dir = "C:/Users/vikasmit/cloud9/.claude/worktrees/lane-e/docs/qa/lane-e/";
  const done = [];
  await page.setViewportSize({ width: 1680, height: 1000 });
  for (const os of ["dark", "light"]) {
    for (const palette of ["cloud9-pine", "high-contrast-dark", "midnight", "nord"]) {
      await page.emulateMedia({ colorScheme: os });
      await page.evaluate((p) => {
        const raw = JSON.parse(localStorage.getItem("cloud9.prefs") || "{}");
        raw.appearanceMode = "system"; raw.palette = p; raw.workspaceLayout = "chat-files";
        localStorage.setItem("cloud9.prefs", JSON.stringify(raw));
      }, palette);
      await page.reload();
      await page.waitForSelector('.rail-btn[aria-current="true"]', { timeout: 20000 });
      await page.waitForTimeout(700);
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none !important;animation:none !important;}" }).catch(() => {});
      const name = `after-os-${os}-${palette}-rail.png`;
      await page.locator(".rail").first().screenshot({ path: dir + name }).catch(() => {});
      done.push({ name, theme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")) });
    }
  }
  return JSON.stringify(done);
}
