import express from "express";
import { z } from "zod";
import { userController } from "../controllers/userController";
import { protect } from "../middlewares/authMiddleware";
import { validate } from "../middlewares/validate";
import { userIdSchema } from "../lib/schemas";
import { uploadImage } from "../lib/uploads";

export const userRouter = express.Router();

userRouter.use(protect);

/**
 * @openapi
 * tags:
 *   name: Users
 *   description: The signed-in user's own record
 */

/**
 * @openapi
 * /users/me:
 *   get:
 *     summary: The signed-in user
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The user
 *       401:
 *         description: Not signed in
 */
userRouter.get("/me", userController.getMe);

/**
 * @openapi
 * /users/me:
 *   patch:
 *     summary: Update the signed-in user's profile
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               image: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: The updated user
 */
userRouter.patch(
  "/me",
  validate(
    z.object({
      body: z.object({
        name: z.string().trim().min(1).max(100).optional(),
        // http(s) only: Zod's url() also accepts `javascript:` and `data:`.
        image: z
          .string()
          .max(2048)
          .url()
          .refine(value => /^https?:\/\//i.test(value), "Use an http or https address")
          .nullable()
          .optional(),
      }),
    })
  ),
  userController.updateMe
);

/**
 * @openapi
 * /users/me/image:
 *   put:
 *     summary: Set the signed-in user's profile photo (multipart field `image`; PNG or JPEG, 2 MB)
 *     description: The user's `image` becomes `/api/users/{id}/image?v=…`, which serves it.
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The updated user
 *       400:
 *         description: BAD_IMAGE
 *   delete:
 *     summary: Remove the signed-in user's profile photo (avatars show initials)
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The updated user
 */
userRouter.put("/me/image", validate(z.object({})), uploadImage, userController.setImage);
userRouter.delete("/me/image", validate(z.object({})), userController.removeImage);

/**
 * @openapi
 * /users/{userId}/image:
 *   get:
 *     summary: A person's uploaded profile photo
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The image
 *       404:
 *         description: No photo
 */
userRouter.get("/:userId/image", validate(userIdSchema), userController.image);

/**
 * @openapi
 * /users/me:
 *   delete:
 *     summary: Permanently delete the signed-in account
 *     description: Refused with 403 ACCOUNT_DELETION_DISABLED unless the API runs with
 *       ALLOW_ACCOUNT_DELETION=true.
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 description: Must match the account's email, as confirmation.
 *     responses:
 *       200:
 *         description: Deleted
 *       400:
 *         description: EMAIL_MISMATCH
 *       403:
 *         description: ACCOUNT_DELETION_DISABLED
 */
userRouter.delete(
  "/me",
  validate(z.object({ body: z.object({ email: z.string().email() }) })),
  userController.deleteMe
);
