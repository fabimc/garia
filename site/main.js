// Point the Linux download buttons at the latest release assets.
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
    const deb = assets.find((asset) => asset.name.endsWith(".deb"));
    const appimage = assets.find((asset) => /\.AppImage$/i.test(asset.name));
    const arch = assets.find((asset) => /-linux-x86_64\.tar\.gz$/.test(asset.name));
    const primary = deb || appimage || arch;
    if (!primary) return;

    for (const button of buttons) button.href = primary.browser_download_url;

    const meta = document.getElementById("dl-meta");
    if (meta) {
      const version = release.tag_name || "";
      const size = Math.round(primary.size / 1e6);
      meta.firstChild.textContent = `${version} · Linux · ${size} MB · AppImage, .deb, and Arch tarball · `;
    }

    const debButton = document.getElementById("dl-btn-deb");
    const appimageButton = document.getElementById("dl-btn-appimage");
    const archButton = document.getElementById("dl-btn-arch");
    if (debButton && deb) debButton.href = deb.browser_download_url;
    if (appimageButton && appimage) appimageButton.href = appimage.browser_download_url;
    if (archButton && arch) archButton.href = arch.browser_download_url;
  } catch {
    // Keep the fallback links to the latest release page.
  }
})();
