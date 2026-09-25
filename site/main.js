// Point the download buttons straight at the latest DMG, and say which
// version it is. Without the API (offline, rate-limited) the buttons keep
// their fallback: the latest release page.
(async () => {
  const buttons = ["dl-btn", "dl-btn-2", "dl-btn-3"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  try {
    const res = await fetch("https://api.github.com/repos/fabimc/garia/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const dmg = (release.assets || []).find((a) => a.name.endsWith(".dmg"));
    if (!dmg) return;
    for (const b of buttons) b.href = dmg.browser_download_url;
    const meta = document.getElementById("dl-meta");
    if (meta) {
      const mb = Math.round(dmg.size / 1e6);
      const version = release.tag_name || "";
      meta.firstChild.textContent = `${version} · Universal app · ${mb} MB · macOS 11 Big Sur or later · `;
    }
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
