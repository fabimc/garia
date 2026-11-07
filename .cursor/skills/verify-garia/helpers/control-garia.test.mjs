import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chromiumLaunchArgs,
  resolveChromiumExecutable,
} from './control-garia.mjs';

function setExists(paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

test('uses GARIA_CHROME override when present', () => {
  const executable = resolveChromiumExecutable({
    env: { GARIA_CHROME: '/custom/chrome' },
    playwrightExecutablePath: '/bundled/chrome',
    fileExists: setExists(['/custom/chrome']),
  });
  assert.equal(executable, '/custom/chrome');
});

test('uses bundled playwright executable when it exists', () => {
  const executable = resolveChromiumExecutable({
    env: {},
    playwrightExecutablePath: '/bundled/chrome',
    fileExists: setExists(['/bundled/chrome']),
  });
  assert.equal(executable, '/bundled/chrome');
});

test('falls back to PLAYWRIGHT_BROWSERS_PATH chromium directory', () => {
  const executable = resolveChromiumExecutable({
    env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
    playwrightExecutablePath: '/missing/bundled/chrome',
    fileExists: setExists(['/opt/pw-browsers/chromium/chrome-linux/chrome']),
    listDir: () => [],
  });
  assert.equal(executable, '/opt/pw-browsers/chromium/chrome-linux/chrome');
});

test('falls back to versioned chromium directory under PLAYWRIGHT_BROWSERS_PATH', () => {
  const executable = resolveChromiumExecutable({
    env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
    playwrightExecutablePath: '/missing/bundled/chrome',
    fileExists: setExists(['/opt/pw-browsers/chromium-9999/chrome-linux64/chrome']),
    listDir: () => [
      { name: 'webkit-3333', isDirectory: () => true },
      { name: 'chromium-9999', isDirectory: () => true },
    ],
  });
  assert.equal(executable, '/opt/pw-browsers/chromium-9999/chrome-linux64/chrome');
});

test('falls back to system google-chrome when Playwright paths are missing', () => {
  const executable = resolveChromiumExecutable({
    env: {},
    playwrightExecutablePath: '/missing/bundled/chrome',
    fileExists: setExists(['/usr/local/bin/google-chrome']),
    listDir: () => [],
  });
  assert.equal(executable, '/usr/local/bin/google-chrome');
});

test('uses PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override when present', () => {
  const executable = resolveChromiumExecutable({
    env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/custom/pw-chrome' },
    playwrightExecutablePath: '/bundled/chrome',
    fileExists: setExists(['/custom/pw-chrome']),
  });
  assert.equal(executable, '/custom/pw-chrome');
});

test('falls back to system Chrome when PLAYWRIGHT_BROWSERS_PATH is set but empty', () => {
  const executable = resolveChromiumExecutable({
    env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/empty-pw' },
    playwrightExecutablePath: '/missing/bundled/chrome',
    fileExists: setExists(['/usr/bin/google-chrome']),
    listDir: () => [],
  });
  assert.equal(executable, '/usr/bin/google-chrome');
});

test('fails when Chromium override path does not exist', () => {
  let message = '';
  assert.throws(
    () =>
      resolveChromiumExecutable({
        env: { GARIA_CHROME: '/missing/override' },
        playwrightExecutablePath: '/bundled/chrome',
        fileExists: setExists(['/bundled/chrome']),
        fail: (msg) => {
          message = msg;
          throw new Error(msg);
        },
      }),
    /override path does not exist/,
  );
  assert.match(message, /GARIA_CHROME/);
});

test('chromiumLaunchArgs includes Linux sandbox / shm flags', () => {
  const args = chromiumLaunchArgs({
    cdpPort: 9222,
    userDataDir: '/tmp/chrome-profile',
    uiUrl: 'http://127.0.0.1:8765/',
    headed: false,
  });
  assert.ok(args.includes('--no-sandbox'));
  assert.ok(args.includes('--disable-dev-shm-usage'));
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--remote-debugging-port=9222'));
});

test('fails with clear guidance when no executable exists', () => {
  let message = '';
  assert.throws(
    () =>
      resolveChromiumExecutable({
        env: {},
        playwrightExecutablePath: '/missing/bundled/chrome',
        fileExists: () => false,
        listDir: () => [],
        fail: (msg) => {
          message = msg;
          throw new Error(msg);
        },
      }),
    /Chromium executable not found/,
  );
  assert.match(message, /GARIA_CHROME/);
  assert.match(message, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/);
  assert.match(message, /system Chrome/);
});
