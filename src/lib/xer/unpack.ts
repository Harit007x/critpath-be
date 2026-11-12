import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { HttpError } from "../../utils/http";

const gunzipAsync = promisify(gunzip);

/** gzip's magic bytes. An XER file starts with "ERMHDR", so the two cannot be confused. */
export const isGzip = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * The XER bytes of an upload. The web app gzips files before sending them (an XER is text and
 * shrinks about 6x); anything else, such as a plain `curl -F file=@…`, is used as sent.
 * `maxBytes` caps the unzipped size, so a small upload cannot expand into gigabytes.
 */
export async function unpackUpload(bytes: Buffer, maxBytes: number): Promise<Buffer> {
  if (!isGzip(bytes)) return bytes;
  try {
    return await gunzipAsync(bytes, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(413, `Schedules can be at most ${maxBytes / 1024 / 1024} MB`, "LIMIT_FILE_SIZE");
    }
    throw new HttpError(400, "The file could not be unzipped", "BAD_GZIP");
  }
}
