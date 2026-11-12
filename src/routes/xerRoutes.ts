import express from "express";
import { xerController, uploadXer } from "../controllers/xerController";
import { limiter } from "../lib/rate-limit";

/** The schedule checker. Public: no sign-in, and nothing a visitor sends is stored. */
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
 *         description: Broken rows, the three checks and the float histogram
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
 *         description: NOT_AN_XER (no ERMHDR header or no TASK table)
 */
xerRouter.post("/check", limiter(1, 20), uploadXer, xerController.checkUpload);
