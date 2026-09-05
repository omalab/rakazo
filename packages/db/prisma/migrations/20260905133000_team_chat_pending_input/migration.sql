ALTER TABLE "runs"
  ADD COLUMN "teamChatInputClaimedAt" TIMESTAMP(3),
  ADD COLUMN "teamChatInputMirroredAt" TIMESTAMP(3);

ALTER TABLE "external_messages"
  ADD COLUMN "answerRunId" TEXT,
  ADD COLUMN "answerMessageId" TEXT;

CREATE INDEX "external_messages_answerRunId_idx" ON "external_messages"("answerRunId");
