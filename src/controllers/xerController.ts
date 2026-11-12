import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { HttpError, paramOf } from "../utils/http";
import { MAX_XER_BYTES, originalName } from "../lib/uploads";
import { SAMPLES, checkSample } from "../lib/xer/samples";
import { findStoredBySha256, getUpload, getUploadContent, listUploads, saveUpload } from "../lib/xer/store";
import { unpackUpload } from "../lib/xer/unpack";

/** One `.xer` file in field `file`, held in memory until it is parsed and stored (lib/xer/store.ts). */
export const uploadXer = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_XER_BYTES, files: 1 },
  fileFilter: (_req, file, done) => {
    if (/\.xer$/i.test(originalName(file))) done(null, true);
    else done(new HttpError(400, "Choose a Primavera P6 .xer file", "NOT_AN_XER"));
  },
}).single("file");

export const xerController = {
  listSamples(_req: Request, res: Response) {
    res.json({ success: true, data: SAMPLES });
  },

  async checkSample(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await checkSample(paramOf(req, "sampleId")) });
    } catch (error) {
      next(error);
    }
  },

  async checkUpload(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new HttpError(400, "Attach a .xer file in the field `file`", "NO_FILE");
      const bytes = await unpackUpload(req.file.buffer, MAX_XER_BYTES);
      res.json({ success: true, data: await saveUpload(bytes, originalName(req.file)) });
    } catch (error) {
      next(error);
    }
  },

  async listUploads(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await listUploads() });
    } catch (error) {
      next(error);
    }
  },

  /** Lets the web app skip uploading a file that is already stored: it sends the SHA-256 first. */
  async findStored(req: Request, res: Response, next: NextFunction) {
    try {
      const sha256 = paramOf(req, "sha256").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, "Expected a SHA-256 in hex", "BAD_SHA256");
      res.json({ success: true, data: await findStoredBySha256(sha256) });
    } catch (error) {
      next(error);
    }
  },

  async getUpload(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: await getUpload(paramOf(req, "fileId")) });
    } catch (error) {
      next(error);
    }
  },

  async downloadUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const { fileName, content } = await getUploadContent(paramOf(req, "fileId"));
      res.attachment(fileName).type("application/octet-stream").send(content);
    } catch (error) {
      next(error);
    }
  },
};
