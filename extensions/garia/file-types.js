// Keep in step with FILE_EXTS in src-tauri/src/catch.rs and DIRECT_EXTS
// in src/main.js. A type that is a file there has to be a file here, or
// the extension lets the browser keep a download Garia would have taken.
const FILE_EXTS = new Set([
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts",
  "mp3", "flac", "wav", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "alac",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "rtf", "txt", "csv", "epub", "mobi", "djvu",
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "pkg",
  "exe", "msi", "deb", "rpm", "apk", "jar", "bin", "img", "torrent", "xip",
  "json", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp", "dat",
]);

function extensionOf(url) {
  const path = String(url || "").split(/[?#]/, 1)[0];
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function isFileUrl(url) {
  if (typeof url !== "string") return false;
  if (url.startsWith("magnet:")) return true;
  if (!isHttpUrl(url)) return false;
  return FILE_EXTS.has(extensionOf(url));
}

function basenameFromUrl(url) {
  if (!url || url.startsWith("magnet:")) return "";
  const path = url.split(/[?#]/, 1)[0];
  let name = path.split("/").pop() || "";
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name;
}

function basename(path) {
  const name = String(path || "").replace(/\\/g, "/").split("/").pop() || "";
  return name === "." || name === ".." ? "" : name;
}

if (typeof globalThis !== "undefined") {
  globalThis.GARIA_FILE_EXTS = FILE_EXTS;
  globalThis.gariaExtensionOf = extensionOf;
  globalThis.gariaIsFileUrl = isFileUrl;
  globalThis.gariaIsHttpUrl = isHttpUrl;
  globalThis.gariaBasenameFromUrl = basenameFromUrl;
  globalThis.gariaBasename = basename;
}
