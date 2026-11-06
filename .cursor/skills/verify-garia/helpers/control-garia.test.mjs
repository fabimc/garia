import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChromiumExecutable } from './control-garia.mjs';

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
});
