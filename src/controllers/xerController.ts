import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { HttpError, paramOf } from "../utils/http";
import { originalName } from "../lib/uploads";
import { SAMPLES, checkSample } from "../lib/xer/samples";
import { getUpload, getUploadContent, listUploads, saveUpload } from "../lib/xer/store";

const MAX_XER_BYTES = 25 * 1024 * 1024;

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
      res.json({ success: true, data: await saveUpload(req.file.buffer, originalName(req.file)) });
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
