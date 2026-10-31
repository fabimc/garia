import { bytesToBase64 } from "./encode.js";
import { closeOverlay, openOverlay } from "./overlays.js";
import {
  applyIntakePick,
  expandUrlSequence,
  formatIntakeMeta,
  formatMediaOutputName,
  formatMediaRowExplain,
  formatPlaylistRuleNote,
  intakeReviewHint,
  newPackageId,
  packageDisplayName,
  parseMirrorUrls,
  parseUrlSequence,
  qualityChoiceKind,
  rememberedQualityRule,
  reviewIntake,
  urlSequenceHint,
} from "./parity.js";

export function initAddDialog(api) {
  const {
    rpc,
    pollAndSync,
    parseDownloadUrls,
    addOptions,
    orderOptions,
    loginHeaders,
    loginFor,
    catchLabel,
    matchCategory,
    takesChecksum,
    parseChecksum,
    checksumOption,
    getVideoTools,
    videoToolsSummary,
    looksLikeAPage,
    isFtpUrl,
    looksLikeFtpFile,
    buildChoices,
    missingNote,
    formatDuration,
    formatBytes,
    QUALITY_RULES,
    pickByRule,
    safeName,
    targetDir,
    chooseFolderInto,
    holdAdded,
    modalStartAt,
    startMissed,
    resetStartField,
    jobs,
    saveJobs,
    rowChecksums,
    el,
    alreadyHaveUrl = () => false,
    failed = (what, err) => console.error(what, err),
    rememberPackage = () => {},
    siteRuleFor = () => null,
    loadQualityRule = () => "best",
    saveQualityRule = (rule) => rule,
  } = api;

  let lastBatchKey = "";

  // ── Modal ────────────────────────────────────────────────────────────────
  const overlay       = document.getElementById("modal-overlay");
  const modalUrlInput = document.getElementById("modal-url-input");
  const modalError    = document.getElementById("modal-error");
  const torrentInput  = document.getElementById("torrent-file-input");

  const modalChecksumRow  = document.getElementById("modal-checksum-row");
  const modalChecksum     = document.getElementById("modal-checksum");
  const modalChecksumHint = document.getElementById("modal-checksum-hint");
  const modalDirRow       = document.getElementById("modal-dir-row");
  const modalDir          = document.getElementById("modal-dir");
  let dirEdited = false;   // a folder the user typed or chose outlives a retyped URL

  const modalBusy     = document.getElementById("modal-busy");
  const modalBusyText  = document.getElementById("modal-busy-text");
  const modalPlain    = document.getElementById("modal-plain");
  const modalOk       = document.getElementById("modal-ok");
  const modalTitle    = document.getElementById("modal-title");
  const videoPanel    = document.getElementById("video-panel");
  const videoChoices  = document.getElementById("video-choices");
  const videoNote     = document.getElementById("video-note");
  const videoOut      = document.getElementById("video-out");

  const playlistPanel   = document.getElementById("playlist-panel");
  const playlistRule    = document.getElementById("playlist-rule");
  const playlistEntries = document.getElementById("playlist-entries");
  const playlistCount   = document.getElementById("playlist-count");
  const playlistNote    = document.getElementById("playlist-note");
  const playlistRuleNote = document.getElementById("playlist-rule-note");
  const batchPanel      = document.getElementById("batch-panel");
  const batchEntries    = document.getElementById("batch-entries");
  const batchCount      = document.getElementById("batch-count");
  const batchHint       = document.getElementById("batch-hint");
  const batchPackageName = document.getElementById("batch-package-name");
  const sequenceRow = document.getElementById("sequence-row");
  const sequenceHint = document.getElementById("sequence-hint");
  const sequenceExpand = document.getElementById("sequence-expand");
  const mirrorsRow = document.getElementById("mirrors-row");
  const mirrorsInput = document.getElementById("modal-mirrors");
  let batchReferrer = "";
  let batchPackageEdited = false;

  // The dialog is one of five things at a time: asking for a URL, waiting,
  // offering qualities, offering a playlist, or listing an FTP folder.
  // Every widget belongs to exactly one of them, so the state is set in one
  // place rather than toggled eight.
  let modalMode = "url";
  let probed = null;      // the last successful probe, and its choices
  let playlist = null;    // the last flat listing, and which of it is ticked
  let ftpListing = null;  // files ticked; folders open
  let probeToken = 0;     // a probe the user has moved on from must not land

  const MODAL_TITLES = {
    url: "Add download",
    busy: "Add download",
    video: "Download video",
    playlist: "Download playlist",
    ftp: "Browse FTP",
  };

  const ftpPanel   = document.getElementById("ftp-panel");
  const ftpEntries = document.getElementById("ftp-entries");
  const ftpCount   = document.getElementById("ftp-count");
  const ftpNote    = document.getElementById("ftp-note");
  const ftpWhere   = document.getElementById("ftp-where");
  const ftpUp      = document.getElementById("ftp-up");
  const modalLogin = document.getElementById("modal-login");
  const addWhen    = document.getElementById("add-when");
  const addStartAt   = document.getElementById("add-start-at");
  const addStartHint = document.getElementById("add-start-hint");

  function renderStartHint() {
    const missed = startMissed("add-start-on", "add-start-at");
    addStartHint.classList.toggle("hidden", !missed);
    return missed;
  }

  // Checked again on submit: the sheet can sit open past the time it was given.
  function startTimeMissed() {
    if (!renderStartHint()) return false;
    addStartAt.focus();
    return true;
  }

  // Add to queue and a start time are both aria2's pause-on-add.
  function holdOnAdd(at) {
    return Boolean(at) || addWhen.querySelector('input[value="queue"]').checked;
  }

  function setModalMode(mode) {
    modalMode = mode;
    const isUrl = mode === "url";
    document.querySelector(".modal-input-row").classList.toggle("hidden", !isUrl);
    document.querySelector('label[for="modal-url-input"]').classList.toggle("hidden", !isUrl);
    modalBusy.classList.toggle("hidden", mode !== "busy");
    videoPanel.classList.toggle("hidden", mode !== "video");
    playlistPanel.classList.toggle("hidden", mode !== "playlist");
    ftpPanel.classList.toggle("hidden", mode !== "ftp");
    if (mode !== "url") {
      batchPanel.classList.add("hidden");
      modalLogin.classList.add("hidden");
    }
    modalOk.classList.toggle("hidden", mode === "busy");
    // The playlist and the FTP list each count what is ticked.
    if (mode !== "playlist" && mode !== "ftp") {
      modalOk.textContent = mode === "video" ? "Download" : "OK";
      modalOk.disabled = false;
    }
    addWhen.classList.toggle("hidden", mode === "busy");
    const addStart = document.getElementById("add-start");
    if (addStart) addStart.classList.toggle("hidden", mode === "busy");
    modalTitle.textContent = MODAL_TITLES[mode] || MODAL_TITLES.url;
    // Last, and after the OK button has been re-enabled above: the hash is the
    // one thing in the dialog that can disable it again.
    renderChecksum();
  }

  // One source for the rules, so the list and the reading of it can't drift.
  playlistRule.append(...QUALITY_RULES.map((r) => {
    const option = document.createElement("option");
    option.value = r.id;
    option.textContent = r.detail ? `${r.label} — ${r.detail}` : r.label;
    return option;
  }));

  // A URL whose host garia has a login for, said before the download starts —
  // a 401 three seconds later is a worse way to find out, and a site with a
  // login saved is exactly the one where a typo in the host goes unnoticed.
  function renderModalLogin() {
    const url = modalUrlInput.value.trim();
    const login = loginFor(url);
    const rule = siteRuleFor(url);
    if (login) {
      modalLogin.classList.remove("hidden");
      modalLogin.textContent = login.username
        ? `Signing in to ${login.host} as ${login.username}`
        : `Sending your saved headers for ${login.host}`;
      return;
    }
    if (rule) {
      modalLogin.classList.remove("hidden");
      const bits = [];
      if (rule.referrer) bits.push("referrer");
      if (rule.alwaysQueue) bits.push("queued");
      if (rule.defaultDir) bits.push("folder");
      modalLogin.textContent = bits.length
        ? `Site rule for ${rule.host}: ${bits.join(", ")}`
        : `Site rule for ${rule.host}`;
      return;
    }
    modalLogin.classList.add("hidden");
  }

  // Three things to say and one field to say them in: nothing yet, the digest
  // aria2 will check against, or why what is there cannot be one. The OK button
  // goes with it — a hash aria2 would refuse is a download that never starts,
  // and finding that out on submit is a worse place to find it out.
  function paintBatchCounts() {
    let on = 0;
    for (const box of batchEntries.querySelectorAll("input[type=checkbox]")) {
      if (box.checked) on++;
    }
    batchCount.textContent = on === 1 ? "1 selected" : `${on} selected`;
    modalOk.textContent = on ? `Download ${on}` : "Download";
    modalOk.disabled = on === 0;
  }

  // A batch adds each ticked URL as-is, so a page would land as its HTML.
  // Only links that already name a file start ticked.
  function directFile(url) {
    return isFtpUrl(url) ? looksLikeFtpFile(url) : !looksLikeAPage(url);
  }

  function urlHost(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }

  function basenameGuess(url) {
    if (/^magnet:/i.test(url)) return "";
    const path = String(url || "").split(/[?#]/, 1)[0];
    let name = path.split("/").pop() || "";
    try { name = decodeURIComponent(name); } catch { /* keep */ }
    return name === "." || name === ".." ? "" : name;
  }

  function defaultBatchPackageName(urls) {
    const hosts = new Map();
    for (const url of urls || []) {
      const host = urlHost(url);
      if (!host) continue;
      hosts.set(host, (hosts.get(host) || 0) + 1);
    }
    let top = "";
    let topN = 0;
    for (const [host, n] of hosts) {
      if (n > topN) { top = host; topN = n; }
    }
    const rule = siteRuleFor(urls?.[0] || "");
    if (rule?.packagePrefix) {
      const n = (urls || []).length;
      return n > 1 ? `${rule.packagePrefix} (${n})` : rule.packagePrefix;
    }
    return packageDisplayName({
      referrer: batchReferrer,
      host: top,
      count: (urls || []).length,
    });
  }

  function renderBatch() {
    const urls = parseDownloadUrls(modalUrlInput.value);
    const show = modalMode === "url" && urls.length > 1;
    batchPanel.classList.toggle("hidden", !show);
    if (!show) {
      lastBatchKey = "";
      if (batchHint) batchHint.classList.add("hidden");
      if (modalMode === "url") modalOk.textContent = "OK";
      return;
    }
    const key = urls.join("\n");
    if (key === lastBatchKey) {
      paintBatchCounts();
      return;
    }
    lastBatchKey = key;
    if (batchPackageName && !batchPackageEdited) {
      batchPackageName.value = defaultBatchPackageName(urls);
    }
    const kept = new Map();
    for (const box of batchEntries.querySelectorAll("input[type=checkbox]")) {
      kept.set(box.dataset.url, box.checked);
    }
    const reviewed = reviewIntake(urls, {
      isDirectFile: directFile,
      alreadyHave: alreadyHaveUrl,
    });
    const keptNames = new Map();
    for (const input of batchEntries.querySelectorAll("input.batch-entry-out")) {
      keptNames.set(input.dataset.url, input.value);
    }
    batchEntries.textContent = "";
    for (const row of reviewed) {
      const meta = formatIntakeMeta(row);
      const label = document.createElement("label");
      label.className = "batch-entry is-link";
      if (row.content) label.dataset.content = row.content;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.url = row.url;
      box.dataset.file = row.file ? "true" : "false";
      box.dataset.queued = row.queued ? "true" : "false";
      box.dataset.content = row.content || "";
      box.checked = kept.has(row.url) ? kept.get(row.url) : row.selected;
      const name = document.createElement("input");
      name.type = "text";
      name.className = "batch-entry-out field-input";
      name.dataset.url = row.url;
      name.value = keptNames.get(row.url) ?? basenameGuess(row.url);
      name.placeholder = catchLabel(row.url);
      name.title = row.url;
      name.autocomplete = "off";
      name.spellcheck = false;
      name.addEventListener("click", (e) => e.stopPropagation());
      const kind = document.createElement("span");
      kind.className = row.file ? "batch-kind is-file" : "batch-kind";
      if (row.content && row.content !== "other" && row.content !== "page") {
        kind.classList.add(`is-${row.content}`);
      }
      kind.textContent = row.label;
      kind.title = meta.mime || row.label;
      const host = document.createElement("span");
      host.className = "batch-entry-host";
      host.textContent = meta.host || urlHost(row.url);
      const cat = document.createElement("span");
      cat.className = "batch-entry-cat";
      if (row.queued) {
        cat.textContent = "In the list";
      } else if (meta.mime) {
        cat.textContent = matchCategory(row.url)?.name || meta.mime;
        cat.title = meta.mime;
      } else {
        cat.textContent = matchCategory(row.url)?.name || "";
      }
      label.append(box, name, kind, host, cat);
      batchEntries.append(label);
    }
    if (batchHint) {
      const hint = intakeReviewHint(reviewed);
      batchHint.textContent = hint;
      batchHint.classList.toggle("hidden", !hint);
    }
    paintBatchCounts();
  }

  function pickBatch(mode) {
    const boxes = [...batchEntries.querySelectorAll("input[type=checkbox]")];
    const next = applyIntakePick(boxes.map((box) => ({
      url: box.dataset.url,
      file: box.dataset.file === "true",
      queued: box.dataset.queued === "true",
      content: box.dataset.content || "",
      selected: box.checked,
    })), mode);
    next.forEach((row, i) => { boxes[i].checked = row.selected; });
    paintBatchCounts();
  }

  function renderSequence() {
    if (!sequenceRow) return;
    const text = modalUrlInput.value.trim();
    const urls = parseDownloadUrls(text);
    // A sequence marker lives inside one URL line — expand it into the
    // same batch review a multi-paste uses.
    const info = urls.length <= 1 ? parseUrlSequence(text) : null;
    const show = modalMode === "url" && Boolean(info);
    sequenceRow.classList.toggle("hidden", !show);
    if (!show) return;
    if (sequenceHint) sequenceHint.textContent = urlSequenceHint(text);
    if (sequenceExpand) {
      sequenceExpand.disabled = !info || info.count < 2 || info.count > 200;
    }
  }

  function renderMirrors() {
    if (!mirrorsRow) return;
    const url = plainFileUrl();
    const show = Boolean(url) && modalMode === "url";
    mirrorsRow.classList.toggle("hidden", !show);
  }

  function renderChecksum() {
    const urls = parseDownloadUrls(modalUrlInput.value);
    const forFile = urls.length === 1 && takesChecksum(urls[0]);
    modalChecksumRow.classList.toggle("hidden", modalMode !== "url" || !forFile);

    const parsed = forFile ? parseChecksum(modalChecksum.value) : null;
    modalChecksumHint.classList.toggle("is-bad", Boolean(parsed?.error));
    modalChecksumHint.textContent = !parsed
      ? "aria2 hashes the file as it arrives, so checking costs the download nothing."
      : parsed.error
        ? parsed.error
        : `${parsed.label}. The download fails rather than finishing if what lands doesn't match.`;

    if (modalMode === "url") modalOk.disabled = Boolean(parsed?.error);
    renderBatch();
    renderDir();
    renderSequence();
    renderMirrors();
  }

  // The URL the Save to field is for: the one submitUrl would hand straight
  // to aria2, or none.
  function plainFileUrl() {
    if (modalMode !== "url") return "";
    const urls = parseDownloadUrls(modalUrlInput.value);
    if (urls.length !== 1) return "";
    const url = urls[0];
    if (isFtpUrl(url) && !looksLikeFtpFile(url)) return "";
    const hashed = takesChecksum(url) && Boolean(parseChecksum(modalChecksum.value));
    return hashed || !looksLikeAPage(url) ? url : "";
  }

  function renderDir() {
    const url = plainFileUrl();
    modalDirRow.classList.toggle("hidden", !url);
    if (url && !dirEdited) modalDir.value = targetDir(url);
  }

  function chosenDir(url) {
    return url === plainFileUrl() ? modalDir.value.trim() : "";
  }

  function openModal(url = "", extras = {}) {
    probeToken++;
    probed = null;
    playlist = null;
    ftpListing = null;
    batchReferrer = extras.referrer || "";
    batchPackageEdited = false;
    if (batchPackageName) batchPackageName.value = extras.packageName || "";
    modalUrlInput.value = Array.isArray(url) ? url.join("\n") : url;
    modalChecksum.value = "";
    if (mirrorsInput) mirrorsInput.value = "";
    modalDir.value      = "";
    dirEdited           = false;
    torrentInput.value  = "";
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");
    batchEntries.textContent = "";
    addWhen.querySelector('input[value="now"]').checked = true;
    resetStartField("add-start-on", "add-start-at");
    renderStartHint();
    lastBatchKey = "";
    renderModalLogin();
    setModalMode("url");
    openOverlay(overlay, { focus: modalUrlInput, close: closeModal });
  }
  function closeModal() {
    probeToken++;   // whatever yt-dlp is doing, it is no longer wanted —
    // and it is told so, rather than left to read a slow page for a minute.
    window.__TAURI__?.core?.invoke("cancel_video_probes").catch(() => {});
    closeOverlay(overlay);
  }

  modalUrlInput.addEventListener("input", () => { renderModalLogin(); renderChecksum(); });
  batchEntries.addEventListener("change", renderBatch);
  document.getElementById("batch-all").addEventListener("click", () => pickBatch("all"));
  document.getElementById("batch-files").addEventListener("click", () => pickBatch("files"));
  document.getElementById("batch-video").addEventListener("click", () => pickBatch("video"));
  document.getElementById("batch-archive").addEventListener("click", () => pickBatch("archive"));
  document.getElementById("batch-none").addEventListener("click", () => pickBatch("none"));
  sequenceExpand?.addEventListener("click", () => {
    const expanded = expandUrlSequence(modalUrlInput.value.trim());
    if (expanded.length < 2) return;
    modalUrlInput.value = expanded.join("\n");
    lastBatchKey = "";
    renderChecksum();
    modalUrlInput.focus();
  });
  batchPackageName?.addEventListener("input", () => {
    batchPackageEdited = batchPackageName.value.trim() !== "";
  });
  modalChecksum.addEventListener("input", renderChecksum);
  // Emptied, the field goes back to following the URL.
  modalDir.addEventListener("input", () => { dirEdited = modalDir.value.trim() !== ""; });
  modalDir.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !startTimeMissed()) submitUrl();
  });
  document.getElementById("modal-dir-browse").addEventListener("click", () => chooseFolderInto(modalDir));
  addStartAt.addEventListener("input", renderStartHint);
  document.getElementById("add-start-on").addEventListener("change", renderStartHint);
  document.getElementById("open-modal-btn").addEventListener("click", () => openModal());
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // Browse → open native file picker for .torrent
  document.getElementById("browse-btn").addEventListener("click", () => torrentInput.click());

  // When a torrent file is chosen, submit immediately
  torrentInput.addEventListener("change", async () => {
    const file = torrentInput.files[0];
    if (!file) return;
    if (startTimeMissed()) {
      torrentInput.value = "";   // so choosing the same file again fires
      return;
    }
    await submitTorrent(file);
  });

  async function submitTorrent(file) {
    modalError.classList.add("hidden");
    try {
      const buf = await file.arrayBuffer();
      const b64 = bytesToBase64(buf);
      const at = modalStartAt();
      const gid = await rpc("aria2.addTorrent", [b64, [], addOptions(undefined, { queue: holdOnAdd(at) })]);
      await holdAdded(gid, at);
      closeModal();
      await pollAndSync();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove("hidden");
    }
  }

  // A .torrent the system opened — Finder, Open With, File → Open Torrent.
  // The bytes come from Rust so the webview never has to read an arbitrary path.
  // The same path can arrive twice (the live event and the pending drain);
  // one add is enough.
  const recentlyOpened = new Set();
  async function ingestTorrentPath(path) {
    if (!path || recentlyOpened.has(path)) return;
    recentlyOpened.add(path);
    setTimeout(() => recentlyOpened.delete(path), 2500);
    const invoker = window.__TAURI__?.core?.invoke;
    if (typeof invoker !== "function") return;
    try {
      const b64 = await invoker("read_torrent", { path });
      await rpc("aria2.addTorrent", [b64, [], addOptions()]);
      await pollAndSync();
    } catch (err) {
      failed(`Couldn't add ${path.split("/").pop()}`, err);
    }
  }

  // Hands the URL to aria2 exactly as typed. This is what the dialog has
  // always done, and it stays the fallback for everything yt-dlp declines.
  async function addPlainUrl(url, options = addOptions(url, { dir: chosenDir(url) })) {
    modalError.classList.add("hidden");
    // The hash belongs to the URL as typed, so it rides the same call — and
    // only this one, because a video is two files and a playlist is forty.
    const parsed = takesChecksum(url) ? parseChecksum(modalChecksum.value) : null;
    if (parsed?.error) {
      modalError.textContent = parsed.error;
      modalError.classList.remove("hidden");
      return;
    }
    try {
      const at = modalStartAt();
      const mirrors = parseMirrorUrls(mirrorsInput?.value || "", url);
      const uris = [url, ...mirrors];
      const gid = await rpc("aria2.addUri", [uris, {
        ...options,
        ...checksumOption(parsed),
        ...(holdOnAdd(at) ? { pause: "true" } : {}),
      }]);
      await holdAdded(gid, at);
      // aria2 would answer the same thing a tick later; knowing it now is what
      // keeps a small file from finishing before its own badge exists.
      if (parsed?.spec && typeof gid === "string") rowChecksums.set(gid, parsed.spec);
      closeModal();
      await pollAndSync();
    } catch (err) {
      const unreachable = err.message.includes("Failed to fetch") || err.message.includes("Load failed");
      modalError.textContent = unreachable
        ? "aria2 isn't answering yet — give it a moment and try again"
        : err.message;
      modalError.classList.remove("hidden");
      setModalMode("url");
    }
  }

  async function addBatch(candidates) {
    const boxes = [...batchEntries.querySelectorAll("input[type=checkbox]")];
    const outs = new Map();
    for (const input of batchEntries.querySelectorAll("input.batch-entry-out")) {
      outs.set(input.dataset.url, input.value.trim());
    }
    const urls = boxes.length
      ? boxes.filter((box) => box.checked).map((box) => box.dataset.url)
      : candidates;
    if (!urls.length) return;
    const at = modalStartAt();
    const rule = siteRuleFor(urls[0] || "");
    const queue = holdOnAdd(at) || Boolean(rule?.alwaysQueue);
    modalError.classList.add("hidden");
    const packageName = (batchPackageName?.value || "").trim()
      || defaultBatchPackageName(urls);
    const packageId = urls.length > 1 ? newPackageId() : "";
    const gids = [];
    try {
      for (const url of urls) {
        const gid = await rpc("aria2.addUri", [[url], addOptions(url, {
          queue,
          referrer: batchReferrer,
          name: outs.get(url) || "",
        })]);
        await holdAdded(gid, at);
        if (typeof gid === "string") gids.push(gid);
      }
      if (packageId && gids.length) {
        rememberPackage({ id: packageId, name: packageName, gids });
      }
      closeModal();
      await pollAndSync();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove("hidden");
    }
  }

  async function submitUrl() {
    const raw = modalUrlInput.value.trim();
    // A still-unexpanded sequence is treated as a batch once the user hits OK,
    // so they do not have to press Expand first.
    if (parseUrlSequence(raw) && parseDownloadUrls(raw).length <= 1) {
      const expanded = expandUrlSequence(raw);
      if (expanded.length > 1) {
        modalUrlInput.value = expanded.join("\n");
        lastBatchKey = "";
        renderChecksum();
        await addBatch(expanded);
        return;
      }
      if (parseUrlSequence(raw)?.count > 200) {
        showModalError("That sequence is too large — use at most 200 URLs");
        return;
      }
    }
    const urls = parseDownloadUrls(modalUrlInput.value);
    if (urls.length > 1) {
      await addBatch(urls);
      return;
    }
    const url = urls[0];
    if (!url) {
      showModalError("Paste a link, magnet, or FTP address");
      return;
    }
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");

    if (isFtpUrl(url) && !looksLikeFtpFile(url)) {
      await listFtp(url);
      return;
    }

    // A hash is a claim that this URL is a file, which is the question the
    // probe exists to answer. Nobody publishes a SHA-256 for a video page.
    const hashed = takesChecksum(url) && Boolean(parseChecksum(modalChecksum.value));
    if (hashed || !looksLikeAPage(url)) {
      await addPlainUrl(url);
      return;
    }
    if (!getVideoTools().version) {
      offerAsIs("no-ytdlp");
      return;
    }

    const token = ++probeToken;
    modalBusyText.textContent = "Looking for video…";
    setModalMode("busy");

    let probe;
    try {
      probe = await window.__TAURI__.core.invoke("video_probe", { url });
    } catch (err) {
      if (token !== probeToken) return;
      offerAsIs(String(err?.message || err));
      return;
    }
    if (token !== probeToken) return;

    // A "playlist" holding one video is a video. Read it properly and offer
    // qualities, rather than a single checkbox with nothing to compare it to.
    if (probe.kind === "playlist" && probe.entries.length === 1) {
      const only = probe.entries[0];
      try {
        probe = await window.__TAURI__.core.invoke("video_probe", { url: only.url });
      } catch (err) {
        if (token !== probeToken) return;
        offerAsIs(String(err?.message || err));
        return;
      }
      if (token !== probeToken) return;
    }

    if (probe.kind === "playlist") showPlaylist(probe);
    else showPicker(probe, url);
  }

  function offerAsIs(message) {
    setModalMode("url");
    // yt-dlp's own diagnosis — it knows the difference between a login wall,
    // a private video, and a page with nothing on it.
    modalError.textContent = message === "no-ytdlp"
      ? "No yt-dlp to read that page with — see Settings"
      : message;
    modalError.classList.remove("hidden");
    // The page may still be a perfectly good file. Offer, don't assume.
    modalPlain.classList.remove("hidden");
  }

  // ── The quality picker ──────────────────────────────────────────────────
  function showPicker(info, sourceUrl) {
    const choices = buildChoices(info, getVideoTools().ffmpeg);
    probed = { info: { ...info, webpageUrl: info.webpageUrl || sourceUrl }, choices, selected: 0 };

    document.getElementById("video-title").textContent = info.title || sourceUrl;
    const sub = [info.uploader, formatDuration(info.duration), info.extractor]
      .filter(Boolean).join(" · ");
    document.getElementById("video-sub").textContent = sub;

    const thumb = document.getElementById("video-thumb");
    thumb.classList.toggle("hidden", !info.thumbnail);
    if (info.thumbnail) thumb.src = info.thumbnail;

    videoChoices.textContent = "";
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "video-choice";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(i === 0));
      btn.dataset.index = String(i);
      btn.innerHTML =
        `<span class="video-choice-label"></span>` +
        `<span class="video-choice-detail"></span>` +
        `<span class="video-choice-size"></span>`;
      btn.querySelector(".video-choice-label").textContent = c.label;
      btn.querySelector(".video-choice-detail").textContent = c.detail;
      btn.dataset.ext = c.ext || "";
      // An estimate is still worth showing — it's the difference between a
      // 40 MB clip and a 4 GB one — but it shouldn't read as a promise.
      btn.querySelector(".video-choice-size").textContent = c.bytes ? formatBytes(c.bytes) : "";
      videoChoices.appendChild(btn);
    });

    const missing = missingNote(info, choices, getVideoTools().ffmpeg);
    const tools = typeof videoToolsSummary === "function" ? videoToolsSummary() : null;
    const note = [missing, tools?.text].filter(Boolean).join(" ");
    videoNote.textContent = note;
    videoNote.classList.toggle("hidden", !note);
    paintVideoOut();

    modalPlain.classList.toggle("hidden", choices.length > 0);
    setModalMode("video");
    // After the mode, which hands the button back its default state.
    modalOk.disabled = choices.length === 0;
  }

  function paintVideoOut() {
    if (!videoOut) return;
    const choice = probed?.choices?.[probed.selected];
    if (!choice) {
      videoOut.textContent = "";
      videoOut.classList.add("hidden");
      return;
    }
    const kind = qualityChoiceKind(choice);
    const explain = formatMediaRowExplain({
      title: safeName(probed.info?.title),
      ext: choice.ext,
      kind,
      height: choice.height || parseInt(choice.label, 10) || 0,
    });
    const name = formatMediaOutputName({
      title: safeName(probed.info?.title),
      ext: choice.ext,
    });
    videoOut.textContent = explain
      ? `Saves as ${explain}`
      : (name ? `Saves as ${name}` : "");
    videoOut.classList.toggle("hidden", !videoOut.textContent);
  }

  videoChoices.addEventListener("click", (e) => {
    const btn = e.target.closest(".video-choice");
    if (!btn || !probed) return;
    probed.selected = Number(btn.dataset.index);
    for (const el of videoChoices.querySelectorAll(".video-choice")) {
      el.setAttribute("aria-checked", String(el === btn));
    }
    paintVideoOut();
  });

  // ── The playlist picker ─────────────────────────────────────────────────
  // A flat listing: titles and page URLs, no formats. What each entry can
  // actually be downloaded at is a probe of its own, and those only happen for
  // the entries that are still ticked when Download is pressed.
  function showPlaylist(info) {
    playlist = {
      info,
      checked: new Set(
        info.entries.flatMap((entry, i) => alreadyHaveUrl(entry.url) ? [] : [i])
      ),
    };

    document.getElementById("playlist-title").textContent =
      info.title || info.webpageUrl || "Playlist";
    const shown = info.entries.length;
    const held = info.total > shown ? `first ${shown} of ${info.total}` : `${shown} videos`;
    document.getElementById("playlist-sub").textContent =
      [info.uploader, held, info.extractor].filter(Boolean).join(" · ");

    const thumb = document.getElementById("playlist-thumb");
    const art = info.entries.find((e) => e.thumbnail);
    thumb.classList.toggle("hidden", !art);
    if (art) thumb.src = art.thumbnail;

    // Only a cap is worth a note. Everything else the subtitle already said.
    const note = info.total > shown
      ? `Only the first ${shown} are listed — paste the rest of the playlist to reach them.`
      : "";
    playlistNote.textContent = note;
    playlistNote.classList.toggle("hidden", !note);
    const rule = siteRuleFor(info.webpageUrl || modalUrlInput.value.trim());
    playlistRule.value = rememberedQualityRule(
      rule?.qualityRule || loadQualityRule(),
      "best",
    );
    paintPlaylistRule();

    renderPlaylistEntries();
    setModalMode("playlist");
  }

  function renderPlaylistEntries() {
    playlistEntries.textContent = "";
    playlist.info.entries.forEach((entry, i) => {
      const row = el("label", "playlist-entry");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.index = String(i);
      box.checked = playlist.checked.has(i);
      const queued = alreadyHaveUrl(entry.url);
      box.setAttribute("aria-label", queued
        ? `${entry.title || entry.url} is already in the list`
        : `Download ${entry.title || entry.url}`);
      row.append(
        box,
        el("span", "playlist-entry-num", String(i + 1)),
        el("span", "playlist-entry-title", entry.title || entry.url),
        el("span", "playlist-entry-time", queued ? "In the list" : formatDuration(entry.duration)),
      );
      row.title = queued
        ? `${entry.title || entry.url} — already in the list`
        : (entry.title || entry.url);
      playlistEntries.appendChild(row);
    });
    renderPlaylistCount();
  }

  function paintPlaylistRule() {
    if (!playlistRuleNote) return;
    const text = formatPlaylistRuleNote(playlistRule.value);
    playlistRuleNote.textContent = text;
    playlistRuleNote.classList.toggle("hidden", !text);
  }

  function renderPlaylistCount() {
    const picked = playlist.checked.size;
    const total = playlist.info.entries.length;
    playlistCount.textContent = `${picked} of ${total} selected`;
    modalOk.disabled = picked === 0;
    modalOk.textContent = picked ? `Download ${picked}` : "Download";
  }

  playlistEntries.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-index]");
    if (!box || !playlist) return;
    const i = Number(box.dataset.index);
    if (box.checked) playlist.checked.add(i);
    else playlist.checked.delete(i);
    renderPlaylistCount();
  });

  function setAllChecked(on) {
    if (!playlist) return;
    playlist.checked = on ? new Set(playlist.info.entries.map((_, i) => i)) : new Set();
    for (const box of playlistEntries.querySelectorAll("input[data-index]")) {
      box.checked = on;
    }
    renderPlaylistCount();
  }
  playlistRule.addEventListener("change", paintPlaylistRule);
  document.getElementById("playlist-all").addEventListener("click", () => setAllChecked(true));
  document.getElementById("playlist-none").addEventListener("click", () => setAllChecked(false));

  // ── FTP listing ─────────────────────────────────────────────────────────
  // Folders open. Files are ticked. The password, if any, already lived in
  // the site login — this is only the names.
  async function listFtp(url) {
    const token = ++probeToken;
    modalBusyText.textContent = "Listing…";
    setModalMode("busy");
    modalError.classList.add("hidden");
    modalPlain.classList.add("hidden");
    let listing;
    try {
      listing = await window.__TAURI__.core.invoke("ftp_list", { url });
    } catch (err) {
      if (token !== probeToken) return;
      const message = String(err?.message || err);
      if (message === "not-a-directory") {
        await addPlainUrl(url);
        return;
      }
      setModalMode("url");
      modalError.textContent = message;
      modalError.classList.remove("hidden");
      return;
    }
    if (token !== probeToken) return;
    showFtp(listing);
  }

  function showFtp(listing) {
    ftpListing = {
      ...listing,
      checked: new Set(
        listing.entries
          .map((e, i) => (e.dir || alreadyHaveUrl(e.url) ? -1 : i))
          .filter((i) => i >= 0)
      ),
    };
    modalUrlInput.value = listing.url;
    ftpWhere.textContent = listing.path === "/" ? listing.host : `${listing.host}${listing.path}`;
    ftpWhere.title = listing.url;
    const parent = parentFtpUrl(listing.url);
    ftpUp.disabled = !parent;
    ftpUp.classList.toggle("hidden", !parent);

    const note = listing.truncated
      ? "Only the first 2,000 names are listed. Open a folder to see inside it."
      : listing.login && listing.login !== "anonymous"
        ? `Signed in as ${listing.login}`
        : "";
    ftpNote.textContent = note;
    ftpNote.classList.toggle("hidden", !note);

    renderFtpEntries();
    setModalMode("ftp");
  }

  function parentFtpUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (!parts.length) return "";
      parts.pop();
      u.pathname = parts.length ? `/${parts.join("/")}/` : "/";
      return u.toString();
    } catch {
      return "";
    }
  }

  function renderFtpEntries() {
    ftpEntries.textContent = "";
    if (!ftpListing) return;
    ftpListing.entries.forEach((entry, i) => {
      if (entry.dir) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ftp-folder";
        btn.dataset.url = entry.url;
        const name = document.createElement("span");
        name.className = "batch-entry-name";
        name.textContent = entry.name;
        const kind = document.createElement("span");
        kind.className = "ftp-kind";
        kind.textContent = "Folder";
        btn.append(name, kind);
        ftpEntries.append(btn);
        return;
      }
      const label = document.createElement("label");
      label.className = "batch-entry";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.index = String(i);
      box.dataset.url = entry.url;
      box.checked = ftpListing.checked.has(i);
      const name = document.createElement("span");
      name.className = "batch-entry-name";
      name.textContent = entry.name;
      name.title = entry.url;
      const size = document.createElement("span");
      size.className = "batch-entry-cat";
      size.textContent = alreadyHaveUrl(entry.url)
        ? "In the list"
        : (entry.size ? formatBytes(entry.size) : "");
      label.append(box, name, size);
      ftpEntries.append(label);
    });
    renderFtpCount();
  }

  function renderFtpCount() {
    const files = ftpListing.entries.filter((e) => !e.dir).length;
    const on = ftpListing.checked.size;
    ftpCount.textContent = files
      ? (on === 1 ? "1 selected" : `${on} selected`)
      : "No files in this folder";
    modalOk.textContent = on ? `Download ${on}` : "Download";
    modalOk.disabled = on === 0;
  }

  ftpEntries.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-index]");
    if (!box || !ftpListing) return;
    const i = Number(box.dataset.index);
    if (box.checked) ftpListing.checked.add(i);
    else ftpListing.checked.delete(i);
    renderFtpCount();
  });
  ftpEntries.addEventListener("click", (e) => {
    const folder = e.target.closest(".ftp-folder");
    if (!folder) return;
    listFtp(folder.dataset.url);
  });
  ftpUp.addEventListener("click", () => {
    const up = parentFtpUrl(ftpListing?.url || "");
    if (up) listFtp(up);
  });
  document.getElementById("ftp-all").addEventListener("click", () => {
    if (!ftpListing) return;
    ftpListing.checked = new Set(
      ftpListing.entries.map((e, i) => (e.dir ? -1 : i)).filter((i) => i >= 0)
    );
    renderFtpEntries();
  });
  document.getElementById("ftp-none").addEventListener("click", () => {
    if (!ftpListing) return;
    ftpListing.checked = new Set();
    renderFtpEntries();
  });

  async function submitFtp() {
    if (!ftpListing) return;
    const urls = [...ftpListing.checked]
      .sort((a, b) => a - b)
      .map((i) => ftpListing.entries[i]?.url)
      .filter(Boolean);
    if (!urls.length) return;
    const at = modalStartAt();
    const queue = holdOnAdd(at);
    modalError.classList.add("hidden");
    try {
      for (const url of urls) {
        const gid = await rpc("aria2.addUri", [[url], addOptions(url, { queue })]);
        await holdAdded(gid, at);
      }
      closeModal();
      await pollAndSync();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove("hidden");
    }
  }

  // One entry at a time, queued as it resolves rather than after the last one:
  // twelve videos is twelve yt-dlp launches, and a list that fills in while it
  // works is the difference between a wait and a hang. The rule is read
  // against each entry's own formats, because the entries do not share any.
  async function submitPlaylist() {
    if (!playlist) return;
    const picked = [...playlist.checked].sort((a, b) => a - b);
    if (!picked.length) return;

    const rule = playlistRule.value;
    saveQualityRule(rule);
    const token = ++probeToken;
    const failures = [];
    let queued = 0;
    const gids = [];
    const named = playlist.info.title
      ? (picked.length > 1 ? `${playlist.info.title} (${picked.length})` : playlist.info.title)
      : packageDisplayName({
        referrer: playlist.info.webpageUrl || "",
        count: picked.length,
      });

    setModalMode("busy");
    for (const [nth, index] of picked.entries()) {
      if (token !== probeToken) return;
      const entry = playlist.info.entries[index];
      const name = entry.title || entry.url;
      modalBusyText.textContent = `Reading ${nth + 1} of ${picked.length}…`;

      let probe;
      try {
        probe = await window.__TAURI__.core.invoke("video_probe", { url: entry.url });
      } catch (err) {
        failures.push([name, String(err?.message || err)]);
        continue;
      }
      if (token !== probeToken) return;
      if (probe.kind !== "video") {
        failures.push([name, "that entry is a playlist of its own"]);
        continue;
      }

      const choices = buildChoices(probe, getVideoTools().ffmpeg);
      const choice = pickByRule(choices, rule);
      if (!choice) {
        failures.push([name, missingNote(probe, choices, getVideoTools().ffmpeg) ||
          "nothing on it can be fetched as a plain file"]);
        continue;
      }

      try {
        const gid = await queueChoice({ ...probe, webpageUrl: probe.webpageUrl || entry.url }, choice);
        if (gid) gids.push(gid);
        queued++;
        // Untick what is already downloading, so what is left on the panel
        // after a partial run is exactly what still needs one.
        playlist.checked.delete(index);
      } catch (err) {
        failures.push([name, String(err?.message || err)]);
      }
    }

    if (token !== probeToken) return;
    if (gids.length > 1) rememberPackage({ id: newPackageId(), name: named, gids });
    await pollAndSync();
    if (!failures.length) {
      closeModal();
      return;
    }

    // Something didn't read. The ones that did are already downloading, so the
    // panel comes back showing only the leftovers.
    renderPlaylistEntries();
    setModalMode("playlist");
    const [name, why] = failures[0];
    modalError.textContent = failures.length === 1
      ? `Queued ${queued}. “${name}” couldn't be read — ${why}`
      : `Queued ${queued} of ${picked.length}. ${failures.length} couldn't be read; ` +
        `the first, “${name}” — ${why}`;
    modalError.classList.remove("hidden");
  }

  // Queue one picked quality. One format is one download; two are two, and a
  // merge job that turns them back into one file and one row. Shared with the
  // playlist picker, which does this once per entry it read.
  async function queueChoice(info, choice) {
    const base = safeName(info.title) || "video";
    // Routed by what the file will be, not by the page URL — which has no
    // extension at all, and would land every video in the base folder.
    const dir = targetDir(`x.${choice.ext}`);
    const common = { ...(dir ? { dir } : {}), ...orderOptions() };
    // Some sites mint a URL for one User-Agent and 403 every other.
    const referer = info.webpageUrl ? { referer: info.webpageUrl } : {};

    const at = modalStartAt();
    const hold = holdOnAdd(at) ? { pause: "true" } : {};

    if (choice.formats.length === 1) {
      const f = choice.formats[0];
      const gid = await rpc("aria2.addUri", [[f.url], {
        ...common, ...referer, ...hold, out: `${base}.${f.ext}`,
        header: [...f.headers, ...loginHeaders(f.url)],
      }]);
      await holdAdded(gid, at);
      return typeof gid === "string" ? gid : "";
    }

    const [v, a] = choice.formats;
    // yt-dlp's own naming for the halves, so a leftover part is
    // recognisable for what it is.
    const videoName = `${base}.f${v.id}.${v.ext}`;
    const audioName = `${base}.f${a.id}.${a.ext}`;
    const videoGid = await rpc("aria2.addUri", [[v.url], {
      ...common, ...referer, ...hold, out: videoName,
      header: [...v.headers, ...loginHeaders(v.url)],
    }]);
    const audioGid = await rpc("aria2.addUri", [[a.url], {
      ...common, ...referer, ...hold, out: audioName,
      header: [...a.headers, ...loginHeaders(a.url)],
    }]);
    await holdAdded(videoGid, at);
    await holdAdded(audioGid, at);
    jobs.set(videoGid, {
      audioGid,
      dir,
      out: `${base}.${choice.ext}`,
      // Written down now rather than read back later: aria2 forgets a
      // finished download across a restart, and the merge still has to
      // know where its halves are.
      videoPath: dir ? `${dir}/${videoName}` : "",
      audioPath: dir ? `${dir}/${audioName}` : "",
      title: info.title,
      webpageUrl: info.webpageUrl,
      state: "downloading",
    });
    saveJobs();
    return typeof videoGid === "string" ? videoGid : "";
  }

  // Queue what the picker chose.
  async function submitVideo() {
    if (!probed) return;
    const { info, choices, selected } = probed;
    const choice = choices[selected];
    if (!choice) return;

    modalBusyText.textContent = "Queueing…";
    setModalMode("busy");

    try {
      await queueChoice(info, choice);
      closeModal();
      await pollAndSync();
    } catch (err) {
      setModalMode("video");
      modalError.textContent = String(err?.message || err);
      modalError.classList.remove("hidden");
    }
  }

  modalOk.addEventListener("click", () => {
    if (startTimeMissed()) return;
    if (modalMode === "video") submitVideo();
    else if (modalMode === "playlist") submitPlaylist();
    else if (modalMode === "ftp") submitFtp();
    else submitUrl();
  });
  modalPlain.addEventListener("click", () => {
    if (startTimeMissed()) return;
    addPlainUrl(modalUrlInput.value.trim());
  });
  modalUrlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const urls = parseDownloadUrls(modalUrlInput.value);
    if (e.metaKey || e.ctrlKey || urls.length <= 1) {
      e.preventDefault();
      if (!startTimeMissed()) submitUrl();
    }
  });

  function showModalError(message) {
    modalError.textContent = message;
    modalError.classList.remove("hidden");
  }

  return { openModal, closeModal, submitUrl, ingestTorrentPath, showModalError };
}