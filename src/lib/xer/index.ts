import { HttpError } from "../../utils/http";
import { checkSchedule, type CheckReport } from "./checks";
import { decodeXer, parseXer, type ParsedXer } from "./parse";

export type XerCheckResponse = CheckReport & {
  file: {
    /** The stored upload (`XerFile.id`); null for a bundled sample, which is not stored. */
    id: string | null;
    name: string;
    sizeBytes: number;
    sample: string | null;
    uploadedAt: string | null;
  };
};

/** What an upload returns: the report, and whether these exact bytes were already stored. */
export type XerUploadResponse = XerCheckResponse & { alreadyStored: boolean };

/** Parses one XER file. Throws 422 when it cannot be read as XER at all. */
export function readXer(bytes: Buffer): ParsedXer {
  const parsed = parseXer(decodeXer(bytes));
  if (parsed.fatal.length > 0) {
    throw new HttpError(422, parsed.fatal.join(" "), "NOT_AN_XER");
  }
  return parsed;
}

/** Parses and checks one XER file without storing it. */
export function checkXer(bytes: Buffer, fileName: string, sample: string | null = null): XerCheckResponse {
  return {
    file: { id: null, name: fileName, sizeBytes: bytes.length, sample, uploadedAt: null },
    ...checkSchedule(readXer(bytes)),
  };
}
