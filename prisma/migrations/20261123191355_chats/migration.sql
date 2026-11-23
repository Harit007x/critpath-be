-- CreateTable
CREATE TABLE "chat" (
    "id" TEXT NOT NULL,
    "visitor" TEXT NOT NULL,
    "fileId" TEXT,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_message" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_visitor_fileId_updatedAt_idx" ON "chat"("visitor", "fileId", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_message_chatId_id_idx" ON "chat_message"("chatId", "id");

-- AddForeignKey
ALTER TABLE "chat" ADD CONSTRAINT "chat_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "xer_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
