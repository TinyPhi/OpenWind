const APPLICATION_ACTOR_USER_ID_PATTERN = /^apikey:(.+)$/;

/**
 * Extracts the calling application's own ID from `auth.userId` (apikey:<id>).
 * Throws rather than silently falling back on a mismatch to prevent security misattribution.
 */
export function applicationActorIdFromUserId(userId: string): string {
  const match = APPLICATION_ACTOR_USER_ID_PATTERN.exec(userId);
  if (!match) {
    const masked =
      userId.length > 8 ? `${userId.slice(0, 8)}…` : "(too short to mask)";
    throw new Error(
      `applicationActorIdFromUserId: userId "${masked}" does not match the apikey:<id> pattern`,
    );
  }
  return match[1] as string;
}
