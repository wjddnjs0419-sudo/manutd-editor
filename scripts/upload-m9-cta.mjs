#!/usr/bin/env node
/**
 * Upload the once-approved 1080x1350 CTA PNG to ManUtd Editor Supabase Storage.
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... M9_CTA_STORAGE_BUCKET=... \
 *   node scripts/upload-m9-cta.mjs /path/to/CTA_MANUTD_EDITOR_v1.png
 *
 * Will not overwrite existing storage objects.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const path = process.argv[2];
const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.M9_CTA_STORAGE_BUCKET ?? "manutd-card-assets";
const objectPath = "assets/cta.png";

function fail(message) {
  throw new Error(message);
}

if (!path) fail("Usage: node scripts/upload-m9-cta.mjs <CTA_PNG_PATH>");
if (!url || !/^https:\/\/[^\s]+$/u.test(url)) fail("SUPABASE_URL must be HTTPS");
if (!key) fail("SUPABASE_SERVICE_ROLE_KEY is required");
if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(bucket)) fail("Invalid M9_CTA_STORAGE_BUCKET");

const content = await readFile(path);
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
if (content.length < 24 || !content.subarray(0, 8).equals(signature)) fail("CTA must be a PNG");
const width = content.readUInt32BE(16), height = content.readUInt32BE(20);
if (width !== 1080 || height !== 1350) fail(`CTA must be 1080x1350, received ${width}x${height}`);

const target = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
const response = await fetch(target, {
  method: "POST",
  headers: {
    authorization: `Bearer ${key}`,
    apikey: key,
    "content-type": "image/png",
    "x-upsert": "false",
    "cache-control": "public, max-age=31536000, immutable",
  },
  body: content,
});
if (!response.ok) {
  // Error bodies are not logged: they can contain information about the project.
  fail(`CTA_UPLOAD_FAILED_HTTP_${response.status}: check bucket existence and object uniqueness`);
}
console.log(JSON.stringify({
  status: "UPLOADED",
  bucket,
  objectPath,
  pixels: [width, height],
  sha256: createHash("sha256").update(content).digest("hex"),
  sizeBytes: content.length,
}, null, 2));
