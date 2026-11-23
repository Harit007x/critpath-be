/**
 * Saved conversations with the assistant (prisma/schema.prisma, "Schedule assistant").
 *
 * Sign-in is off, so a chat belongs to the browser that started it: the web app keeps a random
 * key and sends it as X-CritPath-Visitor, and only its SHA-256 is stored. Another browser, or the
 * same one after its site data is cleared, has no history. Anyone holding the key can read its
 * chats, which is all it protects; once sign-in is back, chats should belong to the user instead.
 */
import { createHash } from "crypto";
import type { Request } from "express";
import { prisma } from "../../utils/db";
import { HttpError, notFound } from "../../utils/http";
import type { RecordedAnswer } from "./recorder";
import { MAX_CHARS, MAX_TURNS, type Turn } from "./schemas";

export const VISITOR_HEADER = "x-critpath-visitor";
/** Chats listed at once; older ones stay saved. */
const LIST_LIMIT = 50;
const TITLE_CHARS = 80;

/** The stored form of the browser's key. Throws 400 when it sent none, or an odd one. */
export function visitorOf(req: Request): string {
  const key = req.header(VISITOR_HEADER)?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new HttpError(400, "Send a visitor key in X-CritPath-Visitor", "NO_VISITOR");
  }
  return createHash("sha256").update(key).digest("hex");
}

/** The first question, on one line and shortened. */
export function titleOf(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

type SavedMessage = { role: string; content: string; error: string | null };

/**
 * What critpath-ai is sent: the saved chat's last turns, then the new question. Answers that
 * stopped with an error are left out, as are long answers' tails (critpath-ai takes up to
 * MAX_CHARS a turn). The list starts with a question, as critpath-ai requires.
 */
export function historyFor(saved: SavedMessage[], question: string): Turn[] {
  const turns: Turn[] = saved
    .filter(m => m.role === "user" || (!m.error && m.content.trim()))
    .map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content.length <= MAX_CHARS ? m.content : `${m.content.slice(0, MAX_CHARS - 1)}…`,
    }));
  turns.push({ role: "user", content: question });
  const recent = turns.slice(-MAX_TURNS);
  const start = recent.findIndex(t => t.role === "user");
  return recent.slice(start);
}

const messageSelect = { role: true, content: true, error: true, createdAt: true } as const;

/** A saved chat of this visitor's, with its messages in order. 404 when it is not theirs. */
export async function getChat(visitor: string, chatId: string) {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, visitor },
    select: {
      id: true,
      fileId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: { select: messageSelect, orderBy: { id: "asc" } },
    },
  });
  if (!chat) throw notFound("Chat");
  return chat;
}

/** This visitor's chats, most recent first: all of them, or those about one file. */
export async function listChats(visitor: string, fileId?: string) {
  const chats = await prisma.chat.findMany({
    where: { visitor, ...(fileId ? { fileId } : {}) },
    select: {
      id: true,
      fileId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: LIST_LIMIT,
  });
  return chats.map(({ _count, ...chat }) => ({ ...chat, messageCount: _count.messages }));
}

export async function deleteChat(visitor: string, chatId: string) {
  const { count } = await prisma.chat.deleteMany({ where: { id: chatId, visitor } });
  if (count === 0) throw notFound("Chat");
}

export async function assertFileExists(fileId: string) {
  const file = await prisma.xerFile.findUnique({ where: { id: fileId }, select: { id: true } });
  if (!file) throw notFound("File");
}

/** Saves the question, starting the chat when `chatId` is null. */
export async function saveQuestion(
  visitor: string,
  chatId: string | null,
  fileId: string | null,
  question: string
): Promise<{ id: string; title: string }> {
  const message = { role: "user", content: question };
  if (chatId) {
    return prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date(), messages: { create: message } },
      select: { id: true, title: true },
    });
  }
  return prisma.chat.create({
    data: { visitor, fileId, title: titleOf(question), messages: { create: message } },
    select: { id: true, title: true },
  });
}

export async function saveAnswer(chatId: string, answer: RecordedAnswer) {
  await prisma.chat.update({
    where: { id: chatId },
    data: {
      updatedAt: new Date(),
      messages: { create: { role: "assistant", content: answer.content, error: answer.error } },
    },
  });
}
