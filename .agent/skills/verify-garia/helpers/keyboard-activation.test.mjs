import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const helper = fileURLToPath(new URL("./control-garia", import.meta.url));
const statePath = fileURLToPath(new URL("../.run/state.json", import.meta.url));

test("row controls own Enter and Space without changing list shortcuts", { timeout: 60000 }, async () => {
  assert.equal(existsSync(statePath), false, "clean up the existing verification instance first");
  let browser;
  let launched = false;
  try {
    execFileSync(helper, ["launch"], { stdio: "pipe" });
    launched = true;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    browser = await chromium.connectOverCDP(state.cdpUrl);
    const page = browser.contexts()[0].pages()[0];
    const selected = page.locator('.dl-item[data-gid="aaaa1111"]');
    const other = page.locator('.dl-item[data-gid="bbbb1111"]');
    await selected.locator(".dl-status-cell").click();

    for (const [key, action, status] of [
      ["Enter", "stop", "paused"],
      ["Space", "resume", "waiting"],
      ["Space", "stop", "paused"],
      ["Enter", "resume", "waiting"],
    ]) {
      await other.locator(`[data-action="${action}"]`).press(key);
      await page.waitForFunction(([gid, expected]) =>
        document.querySelector(`.dl-item[data-gid="${gid}"]`)?.dataset.status === expected,
      ["bbbb1111", status]);
      assert.equal(await selected.getAttribute("data-status"), "active");
      assert.equal(await page.locator("#detail-pane").evaluate((el) => el.classList.contains("hidden")), true);
    }

    for (const [key, gid] of [["Enter", "cccc4444"], ["Space", "cccc5555"]]) {
      const request = page.waitForRequest((req) => {
        try { return req.postDataJSON()?.method === "aria2.addUri"; } catch { return false; }
      });
      await page.locator(`[data-gid="${gid}"] [data-action="retry"]`).press(key);
      await request;
      assert.equal(await selected.getAttribute("data-status"), "active");
      assert.equal(await page.locator("#detail-pane").evaluate((el) => el.classList.contains("hidden")), true);
    }

    for (const key of ["Enter", "Space"]) {
      const button = page.locator('[data-gid="cccc2222"] [data-action="reveal"]');
      await button.evaluate((el) => el.addEventListener("click", () => { el.dataset.activated = "yes"; }, { once: true }));
      await button.press(key);
      assert.equal(await button.getAttribute("data-activated"), "yes");
      await button.evaluate((el) => delete el.dataset.activated);
      assert.equal(await selected.getAttribute("data-status"), "active");
    }

    for (const key of ["Enter", "Space"]) {
      await page.locator('[data-gid="cccc2222"] [data-action="remove"]').press(key);
      assert.equal(await page.locator("#confirm-overlay").evaluate((el) => el.classList.contains("hidden")), false);
      await page.locator("#confirm-cancel").click();
      assert.equal(await selected.getAttribute("data-status"), "active");
    }

    for (const key of ["Enter", "Space"]) {
      await page.locator('.dl-item[data-gid="cccc2222"] .dl-name').press(key);
      assert.equal(await page.locator("#detail-pane").evaluate((el) => el.classList.contains("hidden")), false);
      assert.equal(await page.locator('.dl-item[data-gid="cccc2222"]').getAttribute("aria-selected"), "true");
      await page.keyboard.press("Escape");
    }

    await selected.locator(".dl-status-cell").click();
    await selected.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[data-gid="aaaa1111"]')?.dataset.status === "paused");
    await selected.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[data-gid="aaaa1111"]')?.dataset.status === "active");
    await selected.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#detail-pane").evaluate((el) => el.classList.contains("hidden")), false);
  } finally {
    await browser?.close();
    if (launched) execFileSync(helper, ["cleanup"], { stdio: "pipe" });
  }
});
