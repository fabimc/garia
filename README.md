## About

Garia is a fast, easy, and free download manager for macOS. It is built on [aria2](https://aria2.github.io/) and wrapped in a [Tauri](https://tauri.app/) native app.

Garia manages aria2 automatically — it ships its own copy inside the app and starts it with the app. Closing the window leaves downloads running; Quit is what stops them. You never have to touch the command line to download a file.

It comes as:

 * A native macOS GUI application
 * A browser capture extension for Chrome, Firefox, Edge, Brave, Arc, and Safari
 * Bundled aria2, ffmpeg, and yt-dlp sidecars

This is an **alpha**. Pre-built `.app` and `.dmg` builds are on the [Releases](https://github.com/fabimc/garia/releases) page.

Install with Homebrew from the [personal tap](https://github.com/fabimc/homebrew-garia) after a GitHub Release is published:

```sh
brew tap fabimc/garia
brew trust fabimc/garia
brew install --cask garia
```

Visit https://github.com/fabimc/garia for source, issues, and releases.

## Documentation

[Garia's documentation](docs/README.md) is the place for features, building, the bundled tools, and the browser extension.

## Building

Garia builds from the command line with Tauri.

For a more detailed description, dependencies, sidecar notes, signing, and the release workflow, visit [Building Garia](docs/Building.md) in docs.

### Requirements

| Tool | Version | Install |
|------|---------|---------|
| macOS | 11.0+ | — |
| [Xcode Command Line Tools](https://developer.apple.com/xcode/) | — | `xcode-select --install` |
| [Rust](https://www.rust-lang.org/) | 1.70+ | `brew install rust` |
| [Node.js](https://nodejs.org/) | 18+ | `brew install node` |

aria2 and ffmpeg are not on that list. Garia builds both and bundles them — see [Sidecars](docs/Sidecars.md). Video pages also need [yt-dlp](https://github.com/yt-dlp/yt-dlp); a copy is fetched into the bundle, and a `yt-dlp` on `PATH` is preferred if you have one.

### Building Garia from Git (first time)

```sh
git clone https://github.com/fabimc/garia.git
cd garia
npm install
npm run tauri dev
```

The first run takes a few minutes while Cargo compiles the Tauri runtime and the sidecar scripts build aria2 and ffmpeg. Subsequent runs are fast — the scripts are no-ops once the binaries exist.

### Building a Garia release from the command line

```sh
npm run tauri build
```

That produces an `.app` and a `.dmg` in `src-tauri/target/release/bundle/`. This is a Mac app, so those are the only bundle targets.

A universal binary (Apple Silicon and Intel) is a second target:

```sh
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

The result lands under `src-tauri/target/universal-apple-darwin/release/bundle/` and runs natively on both chips. A release tag does this on CI.

## Contributing

Bug reports and pull requests are welcome.

 * Check [existing issues](https://github.com/fabimc/garia/issues) before opening a new one.
 * Documentation lives in `docs/`. Fixes and new pages there are as useful as code.
 * The [browser extension store checklist](docs/Publishing-the-Extension.md) is the path to Chrome Web Store and addons.mozilla.org.

Garia is [MIT](LICENSE). The copy of aria2 inside the app is GPL-2.0-or-later, ffmpeg is LGPL-2.1, and yt-dlp is Unlicense.
