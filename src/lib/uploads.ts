import { randomUUID } from "crypto";
import { createReadStream, mkdirSync } from "fs";
import { open, unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { Request, Response } from "express";
import multer from "multer";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { notFound } from "../utils/http";

/** Where attachment bytes live on disk when R2 is not configured (local development). */
export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads")
);

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const missingR2 = R2_VARS.filter(name => !process.env[name]);
// Half a configuration would quietly fall back to disk, which on Railway is wiped on every deploy.
if (missingR2.length > 0 && missingR2.length < R2_VARS.length)
  throw new Error(`R2 storage needs ${R2_VARS.join(", ")}; missing ${missingR2.join(", ")}`);

/** Set when all R2_* are set: attachments (and backups, lib/backup.ts) then live in that bucket. */
export const r2 =
  missingR2.length === 0
    ? {
        bucket: process.env.R2_BUCKET!,
        client: new S3Client({
          region: "auto",
          // R2_ENDPOINT is for an EU-jurisdiction bucket or a local S3 stand-in.
          endpoint:
            process.env.R2_ENDPOINT ||
            `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
          },
          // The SDK's default CRC checksums on every request are not something R2 needs.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        }),
      }
    : null;

export const storageLabel = r2 ? `R2 bucket "${r2.bucket}"` : `disk (${UPLOAD_DIR})`;

/**
 * Multer writes here. On disk storage that is the final home; with R2 it is a scratch folder the
 * file leaves once it is in the bucket, so the 25 MB limit is multer's, and memory stays flat.
 */
const STAGING_DIR = r2 ? path.join(tmpdir(), "critpath-uploads") : UPLOAD_DIR;
mkdirSync(STAGING_DIR, { recursive: true });

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;

/** Multer hands back names decoded as latin1; browsers send UTF-8. */
export const originalName = (file: Express.Multer.File) =>
  Buffer.from(file.originalname, "latin1").toString("utf8").slice(0, 255) || "file";

/** Random names in STAGING_DIR: the storage keys `objectKey` and `storedPath` accept. */
const storage = multer.diskStorage({
  destination: STAGING_DIR,
  filename: (_req, file, done) => {
    // Keep a short, safe extension so the folder stays browsable; never trust the name itself.
    const ext = path.extname(originalName(file)).toLowerCase();
    done(null, `${randomUUID()}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ""}`);
  },
});

/**
 * Accepts `files` (up to 10, 25 MB each) under random names, and nothing else: multer keeps text
 * fields in memory with no limit on how many, and the web app sends none.
 */
export const uploadFiles = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 0 },
}).array("files", MAX_FILES_PER_UPLOAD);

/** An uploaded image (e.g. a profile photo): small, and already shrunk to 256 px by the web app. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Images that may be uploaded as pictures: raster only, never SVG (it can carry script). */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** A profile photo: PNG or JPEG only (owner, 2026-10-25). The web app sends one of the two. */
export const PHOTO_TYPES = new Set(["image/png", "image/jpeg"]);

/**
 * One `image` file, stored like an attachment (same names, folder and bucket prefix, so
 * `objectKey`, `sendStored` and `removeStoredFiles` apply unchanged), and nothing else.
 */
export const uploadImage = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
}).single("image");

/** Removes an upload that will not be kept, wherever multer put it. */
export const discardUpload = async (file: Express.Multer.File) => {
  await unlink(file.path).catch(() => {});
};

/** Absolute path for a stored file, refusing anything that would escape UPLOAD_DIR. */
export const storedPath = (storageKey: string) => {
  const resolved = path.resolve(UPLOAD_DIR, storageKey);
  if (path.dirname(resolved) !== UPLOAD_DIR) throw new Error("Invalid storage key");
  return resolved;
};

const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/;

/** The bucket key for a storage key: only names `uploadFiles` could have made. */
export const objectKey = (storageKey: string) => {
  if (!KEY_PATTERN.test(storageKey)) throw new Error("Invalid storage key");
  return `attachments/${storageKey}`;
};

/** Moves freshly uploaded files into the bucket. A no-op on disk storage, where they already are. */
export const storeUploads = async (files: Express.Multer.File[]) => {
  if (!r2) return;
  await Promise.all(
    files.map(file =>
      r2.client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: objectKey(file.filename),
          Body: createReadStream(file.path),
          ContentLength: file.size,
          ContentType: file.mimetype || "application/octet-stream",
        })
      )
    )
  );
};

/** Deletes multer's scratch copies once the request is over. A no-op on disk storage. */
export const clearStaged = async (files: Express.Multer.File[]) => {
  if (!r2) return;
  await Promise.all(files.map(file => unlink(file.path).catch(() => {})));
};

/** Best-effort removal; a file already gone is not an error. */
export const removeStoredFiles = async (storageKeys: string[]) => {
  await Promise.all(
    storageKeys.map(async key => {
      try {
        // S3 deletes are idempotent: a missing key answers 204 like a present one.
        if (r2)
          await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: objectKey(key) }));
        else await unlink(storedPath(key));
      } catch (error: any) {
        if (error?.code !== "ENOENT") console.error("Could not remove upload", key, error);
      }
    })
  );
};

const SINGLE_RANGE = /^bytes=\d*-\d*$/;

/**
 * Writes a stored file's bytes to the response, headers other than length and range already set.
 * Honours a single `Range`, which Safari needs to play video at all. Throws 404 when it is gone.
 */
export const sendStored = async (
  req: Request,
  res: Response,
  file: { storageKey: string; size: number }
) => {
  if (!r2) {
    await new Promise<void>((resolve, reject) =>
      res.sendFile(storedPath(file.storageKey), error => (error ? reject(error) : resolve()))
    ).catch(error => {
      throw res.headersSent ? error : notFound("Attachment file");
    });
    return;
  }

  const range = req.headers.range;
  let object;
  try {
    object = await r2.client.send(
      new GetObjectCommand({
        Bucket: r2.bucket,
        Key: objectKey(file.storageKey),
        Range: range && SINGLE_RANGE.test(range) ? range : undefined,
      })
    );
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 416) {
      res.status(416).setHeader("Content-Range", `bytes */${file.size}`).end();
      return;
    }
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404)
      throw notFound("Attachment file");
    throw error;
  }

  res.setHeader("Accept-Ranges", "bytes");
  if (object.ContentLength !== undefined)
    res.setHeader("Content-Length", String(object.ContentLength));
  if (object.ContentRange) res.status(206).setHeader("Content-Range", object.ContentRange);
  await pipeline(object.Body as Readable, res);
};

/** How long a signed link to an attachment works: a leaked one is dead within this (owner, 2026-10-26). */
const LINK_SECONDS = 30 * 60;
/**
 * Links are signed as of the start of the current window, so every request in it gets the same URL
 * and the browser's cache of the bytes (keyed by URL) keeps hitting. Each link therefore works for
 * 20 to 30 minutes after it is handed out.
 */
const LINK_WINDOW_MS = 10 * 60 * 1000;

/**
 * A presigned R2 URL for a stored file, with the type and disposition the API would have sent
 * (R2 answers with them because they are signed into the query, so nobody can change them), and
 * how long the redirect to it may be cached. Null on disk storage, which keeps streaming.
 */
export const signedFileUrl = async (
  storageKey: string,
  headers: { contentType: string; disposition: string }
) => {
  if (!r2) return null;
  const signedAt = Math.floor(Date.now() / LINK_WINDOW_MS) * LINK_WINDOW_MS;
  const url = await getSignedUrl(
    r2.client,
    new GetObjectCommand({
      Bucket: r2.bucket,
      Key: objectKey(storageKey),
      ResponseContentType: headers.contentType,
      ResponseContentDisposition: headers.disposition,
      ResponseCacheControl: `private, max-age=${LINK_SECONDS}`,
    }),
    { expiresIn: LINK_SECONDS, signingDate: new Date(signedAt) }
  );
  // A minute short of expiry, so a cached redirect never hands out a link about to die.
  const maxAge = Math.max(0, Math.floor((signedAt + LINK_SECONDS * 1000 - Date.now()) / 1000) - 60);
  return { url, maxAge };
};

/**
 * Types a browser may render in place. Everything else downloads, so an
 * uploaded HTML or SVG file can never run script on the API's origin.
 */
export const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
]);

const startsWith = (head: Buffer, bytes: number[] | string, at = 0) => {
  const expected = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
  return head.subarray(at, at + expected.length).equals(expected);
};

/** An ISO base media file (mp4, avif): an `ftyp` box first, optionally naming one of `brands`. */
const isoBrand = (head: Buffer, brands?: string[]) => {
  if (!startsWith(head, "ftyp", 4)) return false;
  if (!brands) return true;
  const box = head.subarray(8, Math.min(head.readUInt32BE(0), head.length)).toString("latin1");
  return brands.some(brand => box.includes(brand));
};

/** What the first bytes of each type in INLINE_TYPES must look like. A new inline type needs one. */
const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  "image/png": head => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": head => startsWith(head, [0xff, 0xd8, 0xff]),
  "image/gif": head => startsWith(head, "GIF87a") || startsWith(head, "GIF89a"),
  "image/webp": head => startsWith(head, "RIFF") && startsWith(head, "WEBP", 8),
  "image/avif": head => isoBrand(head, ["avif", "avis"]),
  // PDF readers accept the header anywhere in the first kilobyte.
  "application/pdf": head => head.subarray(0, 1024).includes("%PDF-"),
  "text/plain": head => !head.includes(0),
  "video/mp4": head => isoBrand(head),
  "video/webm": head => startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]),
  "audio/mpeg": head => startsWith(head, "ID3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0),
};

/**
 * The type to store for an upload. The browser's claim is kept, except that an inline type whose
 * bytes do not match it becomes `application/octet-stream`, so only real images, PDFs and media are
 * ever shown in place. PDFs go out without the sandboxing CSP (attachmentController), so for them
 * this check is what stands between a mislabelled file and the page.
 */
export const verifiedType = async (file: Express.Multer.File) => {
  const claimed = file.mimetype || "application/octet-stream";
  const matches = SIGNATURES[claimed];
  if (!matches) return claimed;
  const handle = await open(file.path, "r");
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return matches(head.subarray(0, bytesRead)) ? claimed : "application/octet-stream";
  } finally {
    await handle.close();
  }
};
