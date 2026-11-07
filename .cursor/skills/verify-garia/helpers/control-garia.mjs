#!/usr/bin/env node
/**
 * control-garia — launch, doctor, drive, and clean up a Garia verification instance.
 *
 * Primary surface for agent runs: browser-dev (static `src/` + `npm run mock`).
 * Launch also starts a persistent Chromium (CDP) so browser commands share one page.
 *
 * Usage:
 *   ./helpers/control-garia.mjs launch
 *   ./helpers/control-garia.mjs doctor
 *   ./helpers/control-garia.mjs browser <subcommand> ...
 *   ./helpers/control-garia.mjs rpc <method> [json-params]
 *   ./helpers/control-garia.mjs cleanup
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SKILL_ROOT, "../../..");
const RUN_DIR = join(SKILL_ROOT, ".run");
const STATE_PATH = join(RUN_DIR, "state.json");
const EVIDENCE_ROOT = join(SKILL_ROOT, "evidence");
const DEFAULT_UI_PORT = Number(process.env.GARIA_UI_PORT || 8765);
const DEFAULT_CDP_PORT = Number(process.env.GARIA_CDP_PORT || 9222);
const RPC_URL = process.env.GARIA_RPC_URL || "http://127.0.0.1:6800/jsonrpc";
const MOCK_PORT = 6800;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function clearState() {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function killPid(pid) {
  if (!pid || !alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && alive(pid)) await sleep(50);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 200, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

async function rpcCall(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function portFree(port) {
  return new Promise((resolveFree) => {
    const s = createServer();
    s.once("error", () => resolveFree(false));
    s.once("listening", () => s.close(() => resolveFree(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function findFreePort(preferred) {
  if (await portFree(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 50; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`No free port near ${preferred}`);
}

function spawnDetached(command, args, { cwd, logPath, env } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  return child.pid;
}

export function resolveChromiumExecutable({
  env = process.env,
  playwrightExecutablePath = chromium.executablePath(),
  fileExists = existsSync,
  listDir = readdirSync,
  fail = die,
} = {}) {
  const override = env.GARIA_CHROME || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (override) {
    if (fileExists(override)) return override;
    fail(
      `Chromium override path does not exist: ${override}. ` +
        `Set GARIA_CHROME or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a valid executable.`,
    );
  }

  const bundledExecutable = playwrightExecutablePath;
  if (fileExists(bundledExecutable)) return bundledExecutable;

  const checked = [bundledExecutable];
  const fallbackRoot = env.PLAYWRIGHT_BROWSERS_PATH;
  if (fallbackRoot) {
    const candidates = [
      join(fallbackRoot, "chromium", "chrome-linux", "chrome"),
      join(fallbackRoot, "chromium", "chrome-linux64", "chrome"),
    ];
    try {
      for (const entry of listDir(fallbackRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue;
        candidates.push(join(fallbackRoot, entry.name, "chrome-linux", "chrome"));
        candidates.push(join(fallbackRoot, entry.name, "chrome-linux64", "chrome"));
      }
    } catch {
      // ignore directory read errors; final error below includes base path context
    }
    for (const candidate of candidates) {
      checked.push(candidate);
      if (fileExists(candidate)) return candidate;
    }
  }

  // Cloud / CI images often ship a system Chrome when Playwright's build is absent.
  const systemCandidates = [
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of systemCandidates) {
    checked.push(candidate);
    if (fileExists(candidate)) return candidate;
  }

  fail(
    `Chromium executable not found. Bundled Playwright expected ${bundledExecutable}, ` +
      `${fallbackRoot ? `and no executable was found under PLAYWRIGHT_BROWSERS_PATH=${fallbackRoot}` : `and PLAYWRIGHT_BROWSERS_PATH is not set`}, ` +
      `and no system Chrome/Chromium was found. ` +
      `Set GARIA_CHROME or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a valid Chromium binary. ` +
      `Checked: ${checked.join(", ")}`,
  );
}

/** Chromium argv for verification launches (sandbox flags required on container Linux). */
export function chromiumLaunchArgs({
  cdpPort,
  userDataDir,
  uiUrl,
  headed = false,
  platform = process.platform,
} = {}) {
  return [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Restricted / container Linux runners (no /dev/shm, no user namespace).
    // A macOS or Windows dev machine keeps Chromium's sandbox.
    ...(platform === "linux" ? ["--disable-dev-shm-usage", "--no-sandbox"] : []),
    "--window-size=1280,800",
    ...(headed ? [] : ["--headless=new"]),
    uiUrl,
  ];
}

function publicState(state) {
  return {
    runId: state.runId,
    mode: state.mode,
    uiUrl: state.uiUrl,
    uiPort: state.uiPort,
    cdpUrl: state.cdpUrl,
    rpcUrl: state.rpcUrl,
    evidenceRoot: state.evidenceRoot,
    mockPid: state.mockPid,
    uiPid: state.uiPid,
    chromePid: state.chromePid,
  };
}

async function connectPage(state) {
  const browser = await chromium.connectOverCDP(state.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages().find((p) => p.url().includes(String(state.uiPort))) || context.pages()[0];
  if (!page) page = await context.newPage();
  if (!page.url().includes(String(state.uiPort))) {
    await page.goto(state.uiUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (document.getElementById("conn-text")?.textContent || "").includes("aria2 ·"),
      { timeout: 15000 },
    );
  }
  return { browser, page };
}

async function cmdLaunch() {
  const existing = readState();
  if (
    existing?.uiPid &&
    alive(existing.uiPid) &&
    existing?.mockPid &&
    alive(existing.mockPid) &&
    existing?.chromePid &&
    alive(existing.chromePid)
  ) {
    console.log(JSON.stringify({ ok: true, reused: true, ...publicState(existing) }, null, 2));
    return;
  }
  if (existing) await cmdCleanup({ quiet: true });

  const mockFree = await portFree(MOCK_PORT);
  if (!mockFree) {
    try {
      await rpcCall("aria2.getGlobalStat");
      die(
        `Port ${MOCK_PORT} already answers aria2 JSON-RPC but was not started by control-garia. ` +
          `Stop that process before launching verification. Two instances cannot share the mock RPC port.`,
      );
    } catch {
      die(`Port ${MOCK_PORT} is busy and does not look like aria2 JSON-RPC. Free it before launch.`);
    }
  }

  const runId = process.env.GARIA_RUN_ID || `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const uiPort = await findFreePort(DEFAULT_UI_PORT);
  const cdpPort = await findFreePort(DEFAULT_CDP_PORT);
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(EVIDENCE_ROOT, { recursive: true });

  const mockLog = join(RUN_DIR, "mock.log");
  const uiLog = join(RUN_DIR, "ui.log");
  const chromeLog = join(RUN_DIR, "chrome.log");
  writeFileSync(mockLog, "");
  writeFileSync(uiLog, "");
  writeFileSync(chromeLog, "");

  const mockPid = spawnDetached(process.execPath, ["mock-rpc.js"], {
    cwd: REPO_ROOT,
    logPath: mockLog,
  });
  await waitFor(async () => {
    try {
      await rpcCall("aria2.getGlobalStat");
      return true;
    } catch {
      return false;
    }
  }, { label: "mock aria2 RPC on :6800", timeoutMs: 20000 });

  const uiPid = spawnDetached(
    "python3",
    ["-m", "http.server", String(uiPort), "--directory", "src", "--bind", "127.0.0.1"],
    { cwd: REPO_ROOT, logPath: uiLog },
  );
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  await waitFor(async () => {
    const res = await fetch(uiUrl);
    await res.arrayBuffer();
    return res.ok;
  }, { label: `static UI at ${uiUrl}`, timeoutMs: 15000 });

  const userDataDir = join(RUN_DIR, "chrome-profile");
  mkdirSync(userDataDir, { recursive: true });
  const chromeExecutable = resolveChromiumExecutable();
  const chromePid = spawnDetached(
    chromeExecutable,
    chromiumLaunchArgs({
      cdpPort,
      userDataDir,
      uiUrl,
      // Headless shell is fine on cloud VMs; headed also works when DISPLAY is set.
      headed: process.env.GARIA_HEADED === "1",
    }),
    { logPath: chromeLog },
  );
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  await waitFor(async () => {
    const res = await fetch(`${cdpUrl}/json/version`);
    await res.arrayBuffer();
    return res.ok;
  }, { label: `Chrome CDP at ${cdpUrl}`, timeoutMs: 20000 });

  await waitFor(async () => {
    const { browser, page } = await connectPage({ cdpUrl, uiUrl, uiPort });
    try {
      await page.waitForFunction(
        () => (document.getElementById("conn-text")?.textContent || "").includes("aria2 ·"),
        { timeout: 20000 },
      );
      const listCount = await page.locator("#download-list [role='option']:not(.hidden)").count();
      return listCount > 0;
    } finally {
      await browser.close(); // disconnects CDP client; leaves Chrome process running
    }
  }, { label: "UI connected to mock with download rows", timeoutMs: 45000 });

  const state = {
    runId,
    mode: "browser-dev",
    mockPid,
    uiPid,
    chromePid,
    uiPort,
    uiUrl,
    cdpPort,
    cdpUrl,
    rpcUrl: RPC_URL,
    mockLog,
    uiLog,
    chromeLog,
    evidenceRoot: EVIDENCE_ROOT,
    repoRoot: REPO_ROOT,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  console.log(JSON.stringify({ ok: true, reused: false, ...publicState(state) }, null, 2));
}

async function cmdDoctor() {
  const state = readState();
  const report = {
    ok: false,
    stateFile: existsSync(STATE_PATH),
    mockAlive: false,
    uiAlive: false,
    chromeAlive: false,
    rpcOk: false,
    uiHttpOk: false,
    cdpOk: false,
    connectedLabel: null,
    rowCount: null,
    mode: state?.mode || null,
    uiUrl: state?.uiUrl || null,
    ownedByUs: false,
  };

  if (!state) {
    console.log(JSON.stringify(report, null, 2));
    die("No verification instance state. Run launch first.", 2);
  }

  report.mockAlive = alive(state.mockPid);
  report.uiAlive = alive(state.uiPid);
  report.chromeAlive = alive(state.chromePid);
  report.ownedByUs = report.mockAlive && report.uiAlive && report.chromeAlive;

  try {
    const stat = await rpcCall("aria2.getGlobalStat");
    report.rpcOk = true;
    report.globalStat = stat;
  } catch (err) {
    report.rpcError = String(err.message || err);
  }

  try {
    const res = await fetch(state.uiUrl);
    await res.arrayBuffer();
    report.uiHttpOk = res.ok;
  } catch (err) {
    report.uiHttpError = String(err.message || err);
  }

  try {
    const res = await fetch(`${state.cdpUrl}/json/version`);
    await res.arrayBuffer();
    report.cdpOk = res.ok;
  } catch (err) {
    report.cdpError = String(err.message || err);
  }

  if (report.uiHttpOk && report.rpcOk && report.cdpOk) {
    const { browser, page } = await connectPage(state);
    try {
      await sleep(300);
      report.connectedLabel = await page.locator("#conn-text").textContent();
      report.rowCount = await page.locator("#download-list [role='option']:not(.hidden)").count();
      report.viewTitle = await page.locator("#view-title").textContent();
      report.brandVisible = (await page.locator(".wordmark").textContent())?.replace(/\s+/g, "") === "garia";
    } finally {
      await browser.close();
    }
  }

  report.ok =
    report.ownedByUs &&
    report.rpcOk &&
    report.uiHttpOk &&
    report.cdpOk &&
    typeof report.connectedLabel === "string" &&
    report.connectedLabel.includes("aria2 ·") &&
    report.rowCount > 0 &&
    report.brandVisible === true;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(2);
}

async function cmdCleanup({ quiet = false } = {}) {
  const state = readState();
  if (!state) {
    if (!quiet) console.log(JSON.stringify({ ok: true, cleaned: false, reason: "no state" }, null, 2));
    return;
  }
  await killPid(state.chromePid);
  await killPid(state.uiPid);
  await killPid(state.mockPid);
  const profile = join(RUN_DIR, "chrome-profile");
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  clearState();
  if (!quiet) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          cleaned: true,
          killed: { mockPid: state.mockPid, uiPid: state.uiPid, chromePid: state.chromePid },
          evidencePreserved: state.evidenceRoot,
        },
        null,
        2,
      ),
    );
  }
}

async function withPage(fn) {
  const state = readState();
  if (!state?.uiUrl || !state?.cdpUrl) die("No launched instance. Run launch + doctor first.");
  if (!alive(state.uiPid) || !alive(state.mockPid) || !alive(state.chromePid)) {
    die("Instance processes are not alive. Run doctor, then relaunch if needed.");
  }
  const { browser, page } = await connectPage(state);
  try {
    return await fn(page, state);
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function describeTarget(args) {
  return {
    role: args.role,
    name: args.name,
    css: args.css || args.selector,
    testId: args.testId,
  };
}

async function resolveLocator(page, args) {
  if (args.css || args.selector) return page.locator(args.css || args.selector).first();
  if (args.testId) return page.getByTestId(args.testId).first();
  if (args.role) {
    const opts = {};
    if (args.name) opts.name = args.name;
    return page.getByRole(args.role, opts).first();
  }
  if (args.text) {
    return page.getByText(args.text, { exact: args.exact === true || args.exact === "true" }).first();
  }
  die("Provide a locator: --css, --role [--name], --testId, or --text");
}

function resolveEvidencePath(p) {
  if (!p) return join(EVIDENCE_ROOT, "untitled");
  if (p.startsWith("/")) return p;
  return join(EVIDENCE_ROOT, p);
}

async function visibleRows(page) {
  return page.locator("#download-list [role='option']:not(.hidden)").evaluateAll((els) =>
    els.map((el) => ({
      gid: el.dataset.gid,
      name: el.dataset.name,
      status: el.dataset.status,
      selected: el.getAttribute("aria-selected"),
    })),
  );
}

async function cmdBrowser(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  if (!sub) {
    die("browser requires a subcommand: click | fill | press | snapshot | screenshot | wait | filter | open-add | add-url | open-detail | pause-named | reload | eval");
  }

  if (sub === "reload") {
    await withPage(async (page, state) => {
      await page.goto(state.uiUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => (document.getElementById("conn-text")?.textContent || "").includes("aria2 ·"),
        { timeout: 15000 },
      );
      console.log(JSON.stringify({ ok: true, action: "reload", url: page.url() }, null, 2));
    });
    return;
  }

  if (sub === "click") {
    await withPage(async (page) => {
      const locator = await resolveLocator(page, args);
      await locator.click();
      if (args.wait) await sleep(Number(args.wait) || 500);
      console.log(JSON.stringify({ ok: true, action: "click", target: describeTarget(args) }, null, 2));
    });
    return;
  }

  if (sub === "fill") {
    if (args.value === undefined) die("fill requires --value");
    await withPage(async (page) => {
      const locator = await resolveLocator(page, args);
      await locator.fill(String(args.value));
      console.log(JSON.stringify({ ok: true, action: "fill", target: describeTarget(args), value: args.value }, null, 2));
    });
    return;
  }

  if (sub === "press") {
    if (!args.key) die("press requires --key");
    await withPage(async (page) => {
      if (args.selector || args.role || args.testId || args.css) {
        const locator = await resolveLocator(page, args);
        await locator.press(args.key);
      } else {
        await page.keyboard.press(args.key);
      }
      console.log(JSON.stringify({ ok: true, action: "press", key: args.key }, null, 2));
    });
    return;
  }

  if (sub === "wait") {
    await withPage(async (page) => {
      if (args.text) {
        await page.getByText(args.text, { exact: args.exact === true || args.exact === "true" }).first().waitFor({
          timeout: Number(args.timeout || 10000),
        });
      } else if (args.css || args.role || args.selector) {
        const locator = await resolveLocator(page, args);
        await locator.waitFor({ timeout: Number(args.timeout || 10000) });
      } else if (args.ms) {
        await sleep(Number(args.ms));
      } else {
        die("wait requires --text, a locator, or --ms");
      }
      console.log(JSON.stringify({ ok: true, action: "wait" }, null, 2));
    });
    return;
  }

  if (sub === "snapshot") {
    const path = resolveEvidencePath(args.path || "snapshot.aria.txt");
    await withPage(async (page) => {
      const aria = await page.locator(".app-shell").ariaSnapshot();
      const text = [
        `url: ${page.url()}`,
        `title: ${await page.title()}`,
        `conn: ${await page.locator("#conn-text").textContent()}`,
        `view: ${await page.locator("#view-title").textContent()}`,
        "",
        aria,
      ].join("\n");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      const rows = await visibleRows(page);
      const summaryPath = path.replace(/\.aria\.txt$/, ".rows.json");
      writeFileSync(summaryPath, JSON.stringify(rows, null, 2) + "\n");
      console.log(JSON.stringify({ ok: true, path, rows: summaryPath, rowCount: rows.length }, null, 2));
    });
    return;
  }

  if (sub === "screenshot") {
    const path = resolveEvidencePath(args.path || "screenshot.png");
    await withPage(async (page) => {
      mkdirSync(dirname(path), { recursive: true });
      await page.screenshot({ path, fullPage: Boolean(args.fullPage) });
      console.log(JSON.stringify({ ok: true, path }, null, 2));
    });
    return;
  }

  if (sub === "eval") {
    const expr = args.expr || args._[0];
    if (!expr) die("eval requires --expr");
    await withPage(async (page) => {
      const result = await page.evaluate(expr);
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    });
    return;
  }

  if (sub === "filter") {
    const name = args.name || args._[0];
    if (!name) die("filter requires a sidebar filter name, e.g. Active");
    await withPage(async (page) => {
      await page.locator("#filter-bar .nav-item").filter({ hasText: name }).first().click();
      await sleep(400);
      const title = await page.locator("#view-title").textContent();
      const rows = await visibleRows(page);
      console.log(JSON.stringify({
        ok: true,
        filter: name,
        viewTitle: title,
        rowCount: rows.length,
        names: rows.map((r) => r.name),
      }, null, 2));
    });
    return;
  }

  if (sub === "open-add") {
    await withPage(async (page) => {
      await page.locator("#open-modal-btn").click();
      await page.locator("#modal-overlay:not(.hidden)").waitFor({ timeout: 5000 });
      console.log(JSON.stringify({ ok: true, dialog: "Add download" }, null, 2));
    });
    return;
  }

  if (sub === "add-url") {
    const url = args.url || args._[0];
    if (!url) die("add-url requires --url");
    await withPage(async (page) => {
      if (await page.locator("#modal-overlay.hidden").count()) {
        await page.locator("#open-modal-btn").click();
      }
      await page.locator("#modal-overlay:not(.hidden)").waitFor();
      await page.locator("#modal-url-input").fill(url);
      await page.locator("#modal-ok").click();
      await sleep(1200);
      const name = decodeURIComponent(url.split("/").pop() || url);
      const rows = await visibleRows(page);
      const appeared = rows.some((r) => (r.name || "").includes(name));
      console.log(JSON.stringify({ ok: appeared, url, name, appeared }, null, 2));
      if (!appeared) process.exit(2);
    });
    return;
  }

  if (sub === "open-detail") {
    const name = args.name || args._[0];
    if (!name) die("open-detail requires --name");
    await withPage(async (page) => {
      const row = page.locator("#download-list [role='option']:not(.hidden)").filter({ hasText: name }).first();
      // Name click opens the docked inspector (Enter / dblclick / ⌘I also work).
      await row.locator(".dl-name").click();
      await page.locator("#detail-pane:not(.hidden)").waitFor({ timeout: 8000 });
      const title = await page.locator("#detail-title").textContent();
      console.log(JSON.stringify({ ok: true, detailTitle: title }, null, 2));
    });
    return;
  }

  if (sub === "pause-named") {
    const name = args.name || args._[0];
    if (!name) die("pause-named requires --name");
    await withPage(async (page) => {
      const row = page.locator("#download-list [role='option']:not(.hidden)").filter({ hasText: name }).first();
      await row.locator('.dl-actions [data-action="stop"]').click();
      await sleep(800);
      const status = await row.getAttribute("data-status");
      console.log(JSON.stringify({ ok: status === "paused", name, status }, null, 2));
      if (status !== "paused") process.exit(2);
    });
    return;
  }

  die(`Unknown browser subcommand: ${sub}`);
}

async function cmdRpc(argv) {
  const method = argv[0];
  if (!method) die("rpc requires a method name, e.g. aria2.tellActive");
  let params = [];
  if (argv[1]) {
    try {
      params = JSON.parse(argv[1]);
    } catch {
      die("rpc params must be JSON, e.g. '[]' or '[0,10,[\"gid\",\"status\"]]'");
    }
  }
  const result = await rpcCall(method, params);
  console.log(JSON.stringify({ ok: true, method, result }, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`control-garia — Garia behavioral verification helper

Commands:
  launch              Start mock RPC + static UI + persistent Chromium (CDP)
  doctor              Read-only health check for the instance we launched
  cleanup             Stop only the processes this helper started (keeps evidence/)
  browser <sub> ...   Drive the shared Chromium page (state persists across calls)
  rpc <method> [json] Call aria2 JSON-RPC on the mock

Environment:
  GARIA_UI_PORT       Preferred static UI port (default 8765)
  GARIA_CDP_PORT      Preferred Chromium remote-debugging port (default 9222)
  GARIA_RPC_URL       Mock RPC URL (default http://127.0.0.1:6800/jsonrpc)
  GARIA_RUN_ID        Optional run id stamped into state
  GARIA_HEADED=1      Launch Chromium headed instead of headless
`);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "launch") return cmdLaunch();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "cleanup") return cmdCleanup();
  if (cmd === "browser") return cmdBrowser(rest);
  if (cmd === "rpc") return cmdRpc(rest);
  die(`Unknown command: ${cmd}`);
}

// Run main() only when executed, not when imported by the tests. Compare real
// paths: the bash wrapper passes a logical path (`pwd`), so through a symlink
// (macOS /tmp → /private/tmp, a symlinked checkout) a plain compare never
// matched and `doctor` printed nothing and exited 0 — a false "ready".
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
