# Garia documentation

## 1. General help

New to Garia?

 * Try **Garia Help** in the Help menu (⌘?).
 * Closing the window is not quitting — downloads keep going until you press ⌘Q.
 * Paste a [sample file](Test-Downloads.md) to see the progress bar move.
 * The [feature list](Features.md) is the short tour.

Want to learn more?

 * [Video downloads](Video-Downloads.md)
 * [Browser capture](Browser-Capture.md)
 * [How it works](How-It-Works.md)

## 2. FAQ

* **Why do downloads keep going after I close the window?**
  The red button and ⌘W hide the list. aria2 keeps running, the dock icon stays, and clicking it brings the window back. ⌘Q is the only quit.

* **Where do files land?**
  Settings names the download folder. Optional categories sort new files into folders you name, by file type or by site.

* **How do I catch a download from the browser?**
  See [Browser capture](Browser-Capture.md). Hold Option (or Alt) on a file link to leave that one with the browser.

* **Can I play a video before it finishes?**
  Yes, if the front of the file is on disk. See [Playing a download before it finishes](Playing-Incomplete.md).

* **A download failed with “Needs a login”.**
  Add the site in Settings. See [Downloads behind a login](Authentication.md).

## 3. More documentation

 * [Features](Features.md)
 * [Building Garia](Building.md)
 * [Bundled sidecars](Sidecars.md) — aria2, ffmpeg, yt-dlp
 * [How it works](How-It-Works.md)
 * [Video downloads](Video-Downloads.md)
 * [Playing incomplete files](Playing-Incomplete.md)
 * [Downloads behind a login](Authentication.md) — passwords, headers, cookies, and the HTTP proxy
 * [FTP](FTP.md)
 * [Checksum verification](Checksums.md)
 * [Remote control](Remote-Control.md)
 * [Browser capture](Browser-Capture.md)
 * [Publishing the browser extension](Publishing-the-Extension.md)
 * [Extension privacy](../extensions/PRIVACY.md)
 * [Test downloads](Test-Downloads.md)

## 4. Report a problem / request a feature

 * [Check](https://github.com/fabimc/garia/issues) whether the problem has already been reported.
 * If you do not see a ticket matching your problem or feature, [open a new one](https://github.com/fabimc/garia/issues/new).
 * If you *do* see an existing ticket, please add a comment there.

## 5. For contributors

Garia welcomes help.

 * Code contribution
 * Testing on Intel and Apple Silicon Macs
 * Documentation
 * The [browser extension store listings](Publishing-the-Extension.md)
