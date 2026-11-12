// Point the download buttons at the latest assets and say
// which version it is. Without the API (offline, rate-limited) the buttons
// keep their fallback: the latest release page.
(async () => {
  const buttons = ["dl-btn", "dl-btn-3"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  try {
    const res = await fetch("https://api.github.com/repos/fabimc/garia/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const assets = release.assets || [];
    const deb = assets.find((a) => a.name.endsWith(".deb"));
    const appimage = assets.find((a) => /\.AppImage$/i.test(a.name));

    const primary = deb || appimage;
    if (!primary) return;
    const metaBits = [deb ? "Debian/Ubuntu .deb" : "AppImage", "x86_64"];
    for (const b of buttons) b.href = primary.browser_download_url;

    const meta = document.getElementById("dl-meta");
    if (meta) {
      const mb = Math.round(primary.size / 1e6);
      const version = release.tag_name || "";
      const extra = deb && appimage ? " · AppImage also available · " : " · ";
      meta.firstChild.textContent = `${version} · ${metaBits.join(" · ")} · ${mb} MB${extra}`;
    }

    const debBtn = document.getElementById("dl-btn-deb");
    const appBtn = document.getElementById("dl-btn-appimage");
    if (debBtn && deb) debBtn.href = deb.browser_download_url;
    if (appBtn && appimage) appBtn.href = appimage.browser_download_url;
  } catch {
    // Keep the fallback link.
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
