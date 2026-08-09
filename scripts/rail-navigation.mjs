/**
 * Navigate to a Cloud9 rail destination, opening the More tools drawer when
 * the requested advanced destination is not currently rendered.
 */
export async function clickRail(page, go) {
  let target = page.locator(`.rail [data-go="${go}"]`).first();
  if (await target.count() === 0 || !await target.isVisible()) {
    await page.locator("[data-open-tools]").click();
    target = page.locator(`.rail [data-go="${go}"]`).first();
  }
  await target.click();
  return target;
}
