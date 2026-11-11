// Photos: prepared in the browser (decoded, scaled to the 2400 px edge, re-encoded when needed to fit
// 2 MiB), hashed with SHA-256, declared with POST /uploads (stable requestId), then PUT to the presigned
// URL with the server's headers exactly (the protocol, Uploads).
import { Api, PingFrontError } from "./api.js";
import { isObj } from "./decode.js";
import type { PreparedPhoto } from "./outbox.js";
import type { Runtime } from "./runtime.js";

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2400;
const PASS_THROUGH = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function reencode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PingFrontError("server", "This browser could not prepare the photo.", 0, "invalid_request", { reason: "photo_open" });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new PingFrontError("server", "This browser could not prepare the photo.", 0, "invalid_request", { reason: "photo_open" }))), "image/jpeg", quality),
  );
}

/** Turns a picked, pasted or dropped file into an upload the server accepts. */
export async function preparePhoto(file: Blob, rt: Runtime): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) throw new PingFrontError("server", "Only photos can be sent.", 0, "invalid_request", { reason: "photo_type" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PingFrontError("server", "This photo's format can't be opened here. Try a JPEG or PNG.", 0, "invalid_request", { reason: "photo_open" });
  }
  let { width, height } = bitmap;
  let blob: Blob = file;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (scale < 1 || !PASS_THROUGH.has(file.type) || file.size > MAX_BYTES) {
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    blob = await reencode(bitmap, width, height, 0.86);
    for (let q = 0.76; blob.size > MAX_BYTES && q > 0.3; q -= 0.12) blob = await reencode(bitmap, width, height, q);
  }
  bitmap.close?.();
  if (blob.size > MAX_BYTES) throw new PingFrontError("server", "This photo is too large to send.", 413, "too_large", { reason: "photo_size" });
  return {
    requestId: rt.uuid(),
    blob,
    contentType: (PASS_THROUGH.has(blob.type) ? blob.type : "image/jpeg") as PreparedPhoto["contentType"],
    bytes: blob.size,
    width,
    height,
    sha256: await sha256Hex(blob),
  };
}

/** Declares and uploads one photo; returns its attachment id. Safe to repeat (same requestId). */
export async function uploadPhoto(api: Api, rt: Runtime, photo: PreparedPhoto, signal?: AbortSignal): Promise<string> {
  if (photo.attachmentId) return photo.attachmentId;
  const res = await api.send({
    method: "POST",
    path: "/uploads",
    auth: "bearer",
    scope: "uploads",
    idempotent: true,
    signal,
    body: { requestId: photo.requestId, contentType: photo.contentType, bytes: photo.bytes, width: photo.width, height: photo.height, sha256: photo.sha256 },
  });
  const d = isObj(res.data) ? res.data : {};
  const id = typeof d.attachmentId === "string" ? d.attachmentId : "";
  const url = typeof d.putUrl === "string" ? d.putUrl : "";
  if (!id || !url) throw new PingFrontError("server", "The upload answer was incomplete.", res.status, "unavailable");
  // The browser sets Content-Length itself and refuses it as a header.
  const headers = Object.fromEntries(Object.entries(isObj(d.headers) ? d.headers : {}).filter(([k, v]) => typeof v === "string" && k.toLowerCase() !== "content-length")) as Record<string, string>;
  let put: Response;
  try {
    put = await rt.fetch(url, { method: "PUT", headers, body: photo.blob, signal, credentials: "omit" });
  } catch {
    throw new PingFrontError("network", "The photo could not be uploaded.");
  }
  if (!put.ok) throw new PingFrontError("server", "The photo upload was refused.", put.status, put.status >= 500 ? "unavailable" : "invalid_request", { reason: "photo_upload" });
  photo.attachmentId = id;
  return id;
}
