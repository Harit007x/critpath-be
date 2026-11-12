import { Request, Response, NextFunction } from "express";
import { prisma } from "../utils/db";
import {
  PHOTO_TYPES,
  clearStaged,
  discardUpload,
  removeStoredFiles,
  sendStored,
  storeUploads,
  verifiedType,
} from "../lib/uploads";
import { HttpError, notFound } from "../utils/http";

/** The API's public origin: where an uploaded photo's URL points (BETTER_AUTH_URL). */
const apiOrigin = () => (process.env.BETTER_AUTH_URL || "http://localhost:5000").replace(/\/$/, "");

const publicUser = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} as const;

const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: publicUser });
    if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

const updateMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, image } = req.body as { name?: string; image?: string | null };
    // A new URL replaces an uploaded photo, whose file then goes.
    const before =
      image !== undefined
        ? await prisma.user.findUnique({ where: { id: req.user!.id }, select: { imageKey: true } })
        : null;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(image !== undefined ? { image, imageKey: null, imageType: null } : {}),
      },
      select: publicUser,
    });
    if (before?.imageKey) await removeStoredFiles([before.imageKey]);
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * `PUT /users/me/image` (multipart `image`): a profile photo, PNG or JPEG only, checked and stored
 * by lib/uploads.ts. `image` becomes this API's URL for it, versioned, so every place that shows
 * a person's `image` shows it with no change of its own.
 */
const setImage = async (req: Request, res: Response, next: NextFunction) => {
  const file = req.file;
  try {
    const userId = req.user!.id;
    if (!file) throw new HttpError(400, "Choose an image to upload", "BAD_IMAGE");
    const type = await verifiedType(file);
    if (!PHOTO_TYPES.has(type)) throw new HttpError(400, "Use a PNG or JPEG image", "BAD_IMAGE");
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { imageKey: true },
    });
    await storeUploads([file]);
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        image: `${apiOrigin()}/api/users/${userId}/image?v=${Date.now()}`,
        imageKey: file.filename,
        imageType: type,
      },
      select: publicUser,
    });
    await clearStaged([file]);
    if (before?.imageKey) await removeStoredFiles([before.imageKey]);
    res.json({ success: true, data: user });
  } catch (error) {
    if (file) await discardUpload(file);
    next(error);
  }
};

/** `DELETE /users/me/image`: no photo (an uploaded one or Google's); avatars show initials. */
const removeImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { imageKey: true },
    });
    const user = await prisma.user.update({
      where: { id: userId },
      data: { image: null, imageKey: null, imageType: null },
      select: publicUser,
    });
    if (before?.imageKey) await removeStoredFiles([before.imageKey]);
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * `GET /users/:userId/image`: an uploaded photo, for any signed-in user (404 for a missing one).
 * Narrow `canSeePhoto` once your app has teams. Versioned URL, so cached for good.
 */
/** Who may see whose photo. Every signed-in user, until the app has teams to scope it to. */
const canSeePhoto = (_viewerId: string, _userId: string) => true;

const image = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId ?? "");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { imageKey: true, imageType: true },
    });
    if (
      !user?.imageKey ||
      !user.imageType ||
      !PHOTO_TYPES.has(user.imageType) ||
      !canSeePhoto(req.user!.id, userId)
    )
      throw notFound("Profile photo");
    res.setHeader("Content-Type", user.imageType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    // Sandboxed like any user upload, though only verified raster images get here.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    await sendStored(req, res, { storageKey: user.imageKey, size: 0 });
  } catch (error) {
    if (res.headersSent) res.destroy();
    else next(error);
  }
};

/**
 * Account deletion: refused unless ALLOW_ACCOUNT_DELETION is "true" (the web app has no Danger zone
 * yet). Test runs set it, so the smoke script can remove the users it creates. Turn it on in
 * production once deleting an account also removes everything your app stores for it.
 */
const accountDeletionAllowed = process.env.ALLOW_ACCOUNT_DELETION === "true";

const deleteMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!accountDeletionAllowed)
      throw new HttpError(403, "Accounts cannot be deleted here", "ACCOUNT_DELETION_DISABLED");
    const { email } = req.body as { email: string };
    if (email.trim().toLowerCase() !== req.user!.email.toLowerCase()) {
      res
        .status(400)
        .json({ success: false, code: "EMAIL_MISMATCH", message: "Email does not match" });
      return;
    }
    // Sessions and accounts cascade with the user. Delete your own per-user data here too.
    const userId = req.user!.id;
    const self = await prisma.user.findUnique({
      where: { id: userId },
      select: { imageKey: true },
    });
    await prisma.user.delete({ where: { id: userId } });
    if (self?.imageKey) await removeStoredFiles([self.imageKey]);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const userController = {
  getMe,
  updateMe,
  setImage,
  removeImage,
  image,
  deleteMe,
};
