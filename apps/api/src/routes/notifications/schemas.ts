import { z } from "zod";

// Keyset cursor: "<createdAt ISO>_<id>" — never offset-based (R11), so a
// notification arriving live mid-scroll can't cause the next page to skip or
// repeat a row.
export const ListNotificationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export const NotificationIdParamSchema = z.object({
  id: z.string().uuid(),
});
