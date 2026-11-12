import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isGzip, unpackUpload } from "./unpack";

const xer = Buffer.from("ERMHDR\t19.12\n%T\tTASK\n%F\ttask_id\n%R\t1\n%E\n");

describe("unpackUpload", () => {
  it("unzips a gzipped upload", async () => {
    const zipped = gzipSync(xer);
    expect(isGzip(zipped)).toBe(true);
    expect(await unpackUpload(zipped, 1024)).toEqual(xer);
  });

  it("uses a plain file as sent", async () => {
    expect(isGzip(xer)).toBe(false);
    expect(await unpackUpload(xer, 1024)).toBe(xer);
  });

  it("refuses a file that unzips past the limit", async () => {
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024));
    await expect(unpackUpload(bomb, 1024 * 1024)).rejects.toMatchObject({ statusCode: 413, code: "LIMIT_FILE_SIZE" });
  });

  it("refuses a broken gzip", async () => {
    const broken = gzipSync(xer).subarray(0, 12);
    await expect(unpackUpload(broken, 1024)).rejects.toMatchObject({ statusCode: 400, code: "BAD_GZIP" });
  });
});
