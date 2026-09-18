// aria2 wants a torrent as base64. Spreading every byte into fromCharCode
// throws RangeError on a file of a few megabytes, so this walks in chunks.

const CHUNK = 0x8000;

export function bytesToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
