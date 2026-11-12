import express from "express";
import { xerController, uploadXer } from "../controllers/xerController";
import { limiter } from "../lib/rate-limit";

/**
 * The schedule checker. Public: no sign-in. Uploads are stored in Postgres (lib/xer/store.ts) and
 * listed to every visitor; the bundled samples are read from disk and not stored.
 */
export const xerRouter = express.Router();

/**
 * @openapi
 * tags:
 *   name: XER checker
 *   description: Read a Primavera P6 XER file, flag broken rows, run the schedule checks
 */

/**
 * @openapi
 * /xer/samples:
 *   get:
 *     summary: The bundled public sample schedules
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: The samples
 */
xerRouter.get("/samples", xerController.listSamples);

/**
 * @openapi
 * /xer/samples/{sampleId}/check:
 *   get:
 *     summary: Check one of the bundled samples
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: Broken rows, the three checks and the float histogram; `alreadyStored` is true when the same file was uploaded before (its stored report is returned)
 *       404:
 *         description: NOT_FOUND
 */
xerRouter.get("/samples/:sampleId/check", limiter(1, 60), xerController.checkSample);

/**
 * @openapi
 * /xer/check:
 *   post:
 *     summary: Check an uploaded XER file (multipart field `file`, up to 25 MB)
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: Broken rows, the three checks and the float histogram
 *       400:
 *         description: NO_FILE or NOT_AN_XER (wrong extension)
 *       422:
 *         description: NOT_AN_XER (empty, no ERMHDR header or no TASK table)
 */
xerRouter.post("/check", limiter(1, 20), uploadXer, xerController.checkUpload);

/**
 * @openapi
 * /xer/files:
 *   get:
 *     summary: The 50 most recent uploads, newest first
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: One summary per upload (project, counts, failing activities per check)
 */
xerRouter.get("/files", limiter(1, 60), xerController.listUploads);

/**
 * @openapi
 * /xer/files/{fileId}:
 *   get:
 *     summary: A stored upload's report, as it was when uploaded
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: Same shape as POST /xer/check
 *       404:
 *         description: NOT_FOUND
 */
xerRouter.get("/files/:fileId", limiter(1, 60), xerController.getUpload);

/**
 * @openapi
 * /xer/files/{fileId}/content:
 *   get:
 *     summary: Download a stored upload exactly as it was uploaded
 *     tags: [XER checker]
 *     responses:
 *       200:
 *         description: The .xer file
 *       404:
 *         description: NOT_FOUND
 */
xerRouter.get("/files/:fileId/content", limiter(1, 30), xerController.downloadUpload);
