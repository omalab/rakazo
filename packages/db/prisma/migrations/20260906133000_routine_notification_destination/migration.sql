ALTER TABLE "routines"
  ADD COLUMN "notificationExternalConversationId" TEXT;

ALTER TABLE "routines"
  ADD CONSTRAINT "routines_notificationExternalConversationId_fkey"
  FOREIGN KEY ("notificationExternalConversationId")
  REFERENCES "external_conversations"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "routines_notificationExternalConversationId_idx"
  ON "routines"("notificationExternalConversationId");
