const ids = ["clickCapture", "downloadTakeover", "videoButton"];

async function paint() {
  const { prefs, dismissedHosts } = await gariaLoadPrefs();
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.checked = prefs[id] !== false;
  }

  const section = document.getElementById("sites-section");
  const list = document.getElementById("sites-list");
  list.replaceChildren();
  if (!dismissedHosts.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const host of dismissedHosts) {
    const li = document.createElement("li");
    li.textContent = host;
    list.appendChild(li);
  }
}

async function saveFromForm() {
  const prefs = {};
  for (const id of ids) {
    prefs[id] = document.getElementById(id).checked;
  }
  await gariaSavePrefs(prefs);
}

for (const id of ids) {
  document.getElementById(id).addEventListener("change", () => {
    saveFromForm().catch(() => {});
  });
}

document.getElementById("clear-sites").addEventListener("click", () => {
  gariaSaveDismissedHosts([]).then(paint).catch(() => {});
});

const api = gariaBrowserApi();
if (api?.storage?.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.prefs || changes.dismissedHosts) paint().catch(() => {});
  });
}

paint().catch(() => {});
