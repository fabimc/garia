# Garia browser extension — privacy

The Garia extension does not talk to a Garia server. There is no account, no analytics, and no crash report. When you send a download, the URL (and, when the browser already knows them, the file name and the page you came from) stay on this computer and are handed to the Garia desktop app through the `garia://` link the app registers.

## What the extension sees

- A click on a file link, a download the browser was about to start, a right-click, or the toolbar button.
- On a video page, a Download chip. That sends the **page** address, not the media stream.
- “Download all links on this page” reads the `href` of every link in the tab you asked it to.

Nothing of that is stored by the extension. A long “download all” list that will not fit in the link is copied to the clipboard so Garia can read it, then the handoff tab closes.

## What leaves the browser

Only the desktop app. Garia is a program you already installed. If it is not running, the browser asks the system to open it. If it is not installed, nothing is sent anywhere.

Hold Option (or Alt) while clicking a file link to leave that download with the browser.

## Permissions

The extension asks to run on `http` and `https` pages so a file click and the video chip work wherever you are. It asks for the downloads API so Chrome and Firefox can cancel a file they were about to save and give it to Garia instead. Safari has no such API; there the click on the link is the intercept.

## Contact

https://github.com/fabimc/garia
