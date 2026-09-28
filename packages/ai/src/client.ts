import Anthropic from "@anthropic-ai/sdk";
import { env } from "@platform/config";

/** Thrown when an AI feature is called but `ANTHROPIC_API_KEY` is not configured. */
export class AiNotConfiguredError extends Error {
  readonly code = "AI_NOT_CONFIGURED";

  constructor() {
    super("AI is not configured: set ANTHROPIC_API_KEY to enable AI features");
    this.name = "AiNotConfiguredError";
  }
}

export function isAiConfigured(): boolean {
  return env.ANTHROPIC_API_KEY !== undefined;
}

export function createClient(): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined) throw new AiNotConfiguredError();
  return new Anthropic({ apiKey });
}
