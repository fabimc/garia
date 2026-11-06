#!/usr/bin/env node
/**
 * Capture UX visual baselines over CDP after `control-garia launch`.
 *
 * Depends on verify-garia `control-garia` (issue #83 / PR #88). Do not expect
 * this script to work until that launcher lands and `./helpers/control-garia
 * launch` + `doctor` exit 0 on the machine.
 *
 * Inspector focus-order / focus-trap a11y is not audited here — that checklist
 * belongs with the inspector pane work (issue #80 / PR #90). This script only
 * screenshots the current detail overlay / pane when open.
 *
 * Baselines are written to an output directory for human/PR review. They are
 * not golden files checked into git, and this script is not wired into CI.
 *
 * Usage (from `.cursor/skills/verify-garia`):
 *   ./helpers/control-garia launch
 *   ./helpers/ux-visual-baselines [--out <dir>]
 *   ./helpers/control-garia cleanup
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const STATE_PATH = join(SKILL_ROOT, ".run", "state.json");
const DEFAULT_OUT = join(SKILL_ROOT, "evidence", "ux-baselines");

const WIDTHS = [1280, 760];
const THEMES = ["light", "dark"];
const VIEW_HEIGHT = 800;

const FILTERS = [
  "All Downloads",
  "Torrents",
  "Active",
  "Seeding",
  "Queued",
  "Paused",
  "Completed",
  "Failed",
];

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = resolve(argv[++i] || "");
    else if (a === "-h" || a === "--help") out.help = true;
    else die(`Unknown argument: ${a}`);
  }
  return out;
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(ms = 350) {
  await sleep(ms);
}

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await settle(120);
  }
}

async function shot(page, outDir, name) {
  const path = join(outDir, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function setTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  await settle(200);
}

async function setWidth(page, width) {
  await page.setViewportSize({ width, height: VIEW_HEIGHT });
  await settle(200);
}

async function clickFilter(page, name) {
  await page.locator("#filter-bar .nav-item").filter({ hasText: name }).first().click();
  await settle(400);
}

async function openAdd(page) {
  await dismissOverlays(page);
  await page.locator("#open-modal-btn").click();
  await page.locator("#modal-overlay:not(.hidden)").waitFor({ timeout: 5000 });
  await settle(250);
}

async function openDetail(page) {
  await dismissOverlays(page);
  const rows = page.locator("#download-list [role='option']:not(.hidden)");
  const count = await rows.count();
  if (!count) throw new Error("No download rows to open detail");
  // Prefer a known mock seed when present; otherwise first visible row.
  const ubuntu = rows.filter({ hasText: "Ubuntu" });
  const row = (await ubuntu.count()) ? ubuntu.first() : rows.first();
  // Master / #87: detail opens on row dblclick. After #90 the surface may be
  // #detail-pane; accept either. Full inspector focus-order audit → #90.
  await row.dblclick();
  const detail = page.locator(
    "#detail-overlay:not(.hidden), #detail-pane:not(.hidden), #detail-pane.open, #detail-pane[aria-hidden='false']",
  );
  await detail.first().waitFor({ timeout: 8000 });
  await settle(300);
}

async function captureThemeWidth(page, state, theme, width, rootOut) {
  const outDir = join(rootOut, theme, String(width));
  mkdirSync(outDir, { recursive: true });
  const written = [];

  await page.goto(state.uiUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (document.getElementById("conn-text")?.textContent || "").includes("aria2 ·"),
    { timeout: 20000 },
  );
  await setTheme(page, theme);
  await setWidth(page, width);
  await dismissOverlays(page);

  for (const filter of FILTERS) {
    await clickFilter(page, filter);
    const name = filter === "All Downloads" ? "list-all" : `filter-${slug(filter)}`;
    written.push(await shot(page, outDir, name));
  }

  await clickFilter(page, "All Downloads");
  await openAdd(page);
  written.push(await shot(page, outDir, "add-single"));

  // Batch review: multi-line paste reveals #batch-panel (when intake classifies).
  await page.locator("#modal-url-input").fill(
    ["https://proof.ovh.net/files/1Mb.dat", "https://proof.ovh.net/files/10Mb.dat"].join("\n"),
  );
  await settle(700);
  written.push(await shot(page, outDir, "add-batch"));
  await dismissOverlays(page);

  await openDetail(page);
  written.push(await shot(page, outDir, "detail"));
  await dismissOverlays(page);

  // Settings is a separate page in browser-dev (native uses a window.open popup).
  await page.goto(new URL("settings.html", state.uiUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await setTheme(page, theme);
  await setWidth(page, width);
  await settle(400);
  written.push(await shot(page, outDir, "settings"));

  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`ux-visual-baselines — CDP screenshots for UX review

Requires a live control-garia instance (PR #88 / issue #83 must land first):
  cd .cursor/skills/verify-garia
  ./helpers/control-garia launch
  ./helpers/ux-visual-baselines [--out DIR]
  ./helpers/control-garia cleanup

Default --out: ${DEFAULT_OUT}
Also accepts tmp/ux-baselines/ (or any path). Output is gitignored; not CI.

Inspector focus-order checklist: deferred to PR #90 — do not treat these
PNGs as an a11y audit.
`);
    process.exit(0);
  }

  const state = readState();
  if (!state?.cdpUrl || !state?.uiUrl) {
    die(
      "No live control-garia state at .run/state.json.\n" +
        "Run `./helpers/control-garia launch` first (needs #83/#88 launcher).\n" +
        "Then re-run this script; finish with `./helpers/control-garia cleanup`.",
    );
  }

  const outRoot = args.out || DEFAULT_OUT;
  mkdirSync(outRoot, { recursive: true });

  const browser = await chromium.connectOverCDP(state.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page =
    context.pages().find((p) => p.url().includes(String(state.uiPort))) ||
    context.pages()[0];
  if (!page) page = await context.newPage();

  const all = [];
  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const paths = await captureThemeWidth(page, state, theme, width, outRoot);
        all.push(...paths);
        console.error(`captured ${theme} @ ${width}: ${paths.length} shots`);
      }
    }
  } finally {
    await browser.close(); // disconnect CDP client; leave Chrome running for control-garia
  }

  const manifest = {
    ok: true,
    out: outRoot,
    widths: WIDTHS,
    themes: THEMES,
    count: all.length,
    note:
      "Manual/PR review only — not CI. Launcher: #83/#88. Inspector a11y: #90.",
    files: all,
  };
  writeFileSync(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
