# Publishing the Garia capture extension

The same folder, `extensions/garia`, is the Chrome / Edge / Brave / Arc package and the Firefox package. Safari still goes through `scripts/make-safari-extension.sh`. This note is the store path — Chrome Web Store and addons.mozilla.org — after you have loaded it unpacked and used it for a week.

You cannot finish either store from the command line alone. Each wants an account, a listing, screenshots, and a human review. The zip and the copy-paste text below are what you take to those forms.

## 0. Before you upload

1. Build Garia (`npm run tauri build`) so `garia://` is registered. Reviewers who install the extension without the app will see “Opening Garia…” and nothing else — the listing has to say the desktop app is required.
2. Sideload the **folder** (not the zip) and click a real file, a video Download chip, a context-menu item, and “download all links”.
   - Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extensions/garia`.
   - Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `extensions/garia/manifest.json`. Temporary add-ons die when Firefox quits; that is expected until AMO signs it.
3. Pack the zips:

```sh
./scripts/pack-extension.sh
```

That writes `dist/extensions/garia-chrome.zip` and `garia-firefox.zip`. They are the same archive. `dist/` is gitignored.

Host this privacy policy at a public URL before either dashboard will accept the listing. While the repo is public, this is enough:

`https://github.com/fabimc/garia/blob/main/extensions/PRIVACY.md`

## 1. Chrome Web Store

### Account

1. Sign in to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with a Google account.
2. Pay the one-time **$5** registration. It can take a day to clear.
3. Accept the [developer agreement](https://developer.chrome.com/docs/webstore/program-policies/).

### Upload

1. **New item** → upload `dist/extensions/garia-chrome.zip`.
2. The dashboard reads the manifest. Leave the name **Garia**.

### Listing copy (paste)

**Summary** (132 characters max):

```
Catch file downloads and video pages and send them to the Garia desktop app for macOS.
```

**Description**:

```
Garia is a companion for the Garia download manager on the Mac. The extension does not download files itself. It sends the URL to the desktop app — the same way Internet Download Manager and Free Download Manager do.

You need the Garia app installed. Without it, a click opens a short “Opening Garia…” tab and stops there.

What it does
• Click a file link and Garia takes it. Hold Option (Alt) to leave that one with the browser.
• A download the browser had already started is cancelled and handed over — archives, disk images, video, audio, documents, torrents.
• Right-click a link, a selection, or the page: Download with Garia, send this page, or send every link (reviewed in Garia before they start).
• On a watch page, a Download chip sits on the player. It sends the page, not the stream, so playlists still work and you do not have to press play first. × hides it until the next video.
• The toolbar button sends the page you are on — useful for YouTube and anything yt-dlp can read.

What it does not do
• It does not upload your history. There is no Garia server.
• It does not sniff <video> URLs. The desktop app asks yt-dlp to read the page.

Privacy: https://github.com/fabimc/garia/blob/main/extensions/PRIVACY.md
App and source: https://github.com/fabimc/garia
```

**Category:** Productivity (or Tools).

**Language:** English.

### Store assets

Chrome wants at least one screenshot. Sizes: **1280×800** or **640×400**. Take them from a loaded session:

1. A page with a file link, context menu open on “Download with Garia”.
2. A YouTube watch page with the Download chip on the player.
3. Garia’s add dialog after a capture, so reviewers see where the URL went.

Optional: a 1400×560 promo tile. The 128×128 icon is already in the zip.

### Privacy questionnaire

- Single purpose: *Companion to the Garia desktop download manager. Captures file downloads and video page URLs and hands them to that app.*
- Does not sell data. Does not use it for ads. Does not transfer it off the machine except into the local app.
- Remote code: **No**.
- Privacy policy URL: the GitHub link above.

### Permission justifications (paste)

Chrome asks why each permission exists. Unused ones were already dropped.

| Permission | Justification |
|---|---|
| `host_permissions` (`http://*/*`, `https://*/*`) | File links and the video Download chip have to work on every site the user visits. A download manager cannot name the hosts in advance. |
| `downloads` | Cancel a download Chrome was about to save and send that URL to Garia instead. The extension does not write files. |
| `contextMenus` | “Download with Garia”, “Send this page”, and “Download all links on this page”. |
| `clipboardWrite` | A long “download all” list will not fit in the `garia://` link, so the extra URLs are copied for the desktop app to read. |

### Review

Submit for review. A first listing is often **a few days**; a policy question adds a week. If they ask why you need all sites, the table above is the answer. If they ask why it “does nothing” in the browser, point at the first paragraph: the desktop app is required.

After it is live, the public URL looks like `https://chromewebstore.google.com/detail/garia/<id>`. Put that in Settings later.

### Updates

Bump `version` in `extensions/garia/manifest.json` (and `manifest.safari.json` if Safari should match). Pack again. Dashboard → the item → **Package** → upload the new zip. Same review, usually faster.

## 2. Firefox Add-ons (AMO)

### Account

1. A [Mozilla account](https://addons.mozilla.org/developers/) — free.
2. Accept the [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).

### Lint locally (optional, useful)

```sh
npx --yes web-ext lint --source-dir extensions/garia --ignore-files manifest.safari.json
```

Warnings about `browser_specific_settings.safari` are noise. Errors are not.

### Upload

1. [Submit a new add-on](https://addons.mozilla.org/developers/addon/submit/distribution).
2. Choose **On this site** (listed). Unlisted is only if you want to hand people a signed `.xpi` yourself.
3. Upload `dist/extensions/garia-firefox.zip`.
4. The gecko id is already in the manifest: `garia@fabimc`. Do not change it after the first signed build — Firefox treats a new id as a different add-on.
5. `data_collection_permissions.required` is `none`: nothing leaves the machine toward a Garia server. URLs go to the user’s own app. If review asks, that is the distinction.

### Listing copy (paste)

**Summary** (250 characters max): same sentence as Chrome.

**Description:** same body as Chrome. AMO accepts HTML; a plain-text paste is fine.

**Categories:** Download Management, and Productivity.

On the compatibility form, leave **Firefox for Android** unchecked. Garia is a Mac app; the extension has nowhere to send a URL on a phone.

**Support / homepage:** `https://github.com/fabimc/garia`

**Privacy policy:** the same GitHub URL.

### Notes for reviewers (the form asks)

```
Companion extension for the Garia macOS download manager (https://github.com/fabimc/garia).
It does not fetch files. It opens garia://add?… so the desktop app can queue them.
Requires the Garia app. Tested on Firefox 140+ / macOS.
To try a capture: install Garia, load any page with a .zip or .pdf link, right-click → Download with Garia.
```

### Review

Listed add-ons get a human review. A first one is often **a few days to two weeks**. You will get an email. Once approved, the listing is `https://addons.mozilla.org/firefox/addon/garia/` (the slug may differ).

Firefox will not stay loaded from `about:debugging` across restarts. The store listing is what ordinary people install.

### Updates

Same version bump, new zip, **Upload a new version** on the AMO developer page. Source is already readable — there is no minifier — so you do not need a separate source archive.

## 3. After both are live

1. Replace the sideload instructions in Settings → Capture and in the README with the two store links.
2. Edge and Brave can install the Chrome Web Store listing, or you can submit the same zip to [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview) later. That is a third review, not a third codebase.
3. Safari is still the converter script, then Developer ID / App Store Connect if you want it signed. That is a Mac app, not an AMO/CWS listing.

## 4. What you cannot skip

- The **$5** Chrome developer fee.
- A **public privacy policy URL**. A GitHub file is enough; a Google Doc is not, if it is not world-readable.
- **Screenshots.** Reviewers do open them.
- Saying, in the first lines of the description, that **the Garia desktop app is required**. Companion extensions that hide that get rejected as “doesn’t work”.
