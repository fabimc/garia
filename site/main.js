// Point the download buttons at the latest assets for this platform, and say
// which version it is. Without the API (offline, rate-limited) the buttons
// keep their fallback: the latest release page.
(async () => {
  const ua = navigator.userAgent || "";
  const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);
  const isMac = /Mac OS X|Macintosh/i.test(ua);

  const buttons = ["dl-btn", "dl-btn-2", "dl-btn-3"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const labelLinux = (el) => {
    const span = el.querySelector("span:last-child") || el;
    if (span.textContent && /Download for Mac/i.test(span.textContent)) {
      span.textContent = span.textContent.replace(/Download for Mac/i, "Download for Linux");
    }
  };

  try {
    const res = await fetch("https://api.github.com/repos/fabimc/garia/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const assets = release.assets || [];
    const dmg = assets.find((a) => a.name.endsWith(".dmg"));
    const deb = assets.find((a) => a.name.endsWith(".deb"));
    const appimage = assets.find((a) => /\.AppImage$/i.test(a.name));

    let primary = dmg;
    let metaBits = ["Universal app", "macOS 11 Big Sur or later"];

    if (isLinux) {
      primary = deb || appimage || dmg;
      buttons.forEach(labelLinux);
      if (deb) {
        metaBits = ["Debian/Ubuntu .deb", "x86_64"];
      } else if (appimage) {
        metaBits = ["AppImage", "x86_64"];
      }
    } else if (!isMac && (deb || appimage)) {
      // Unknown platform: keep Mac primary, but the release page has Linux too.
      metaBits = ["macOS · Linux", "see all releases"];
    }

    if (!primary) return;
    for (const b of buttons) b.href = primary.browser_download_url;

    const meta = document.getElementById("dl-meta");
    if (meta) {
      const mb = Math.round(primary.size / 1e6);
      const version = release.tag_name || "";
      const extras = [];
      if (isLinux && deb && appimage) extras.push("AppImage also available");
      if (!isLinux && (deb || appimage)) extras.push("Linux AppImage/.deb on Releases");
      const extra = extras.length ? ` · ${extras.join(" · ")} · ` : " · ";
      meta.firstChild.textContent = `${version} · ${metaBits.join(" · ")} · ${mb} MB${extra}`;
    }

    const linuxCard = document.getElementById("linux-install");
    if (linuxCard) {
      linuxCard.hidden = false;
      const debBtn = document.getElementById("dl-btn-deb");
      const appBtn = document.getElementById("dl-btn-appimage");
      if (debBtn && deb) debBtn.href = deb.browser_download_url;
      if (appBtn && appimage) appBtn.href = appimage.browser_download_url;
    }
  } catch {
    // Keep the fallback link.
    if (isLinux) buttons.forEach(labelLinux);
  }
})();

// Copy-to-clipboard for the install commands.
const toast = document.getElementById("toast");
let toastTimer;
function say(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-copy]");
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.dataset.copy);
    say("Copied to clipboard");
  } catch {
    say("Couldn't copy — select the text instead");
  }
});
