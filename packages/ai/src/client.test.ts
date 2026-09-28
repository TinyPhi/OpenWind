import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: undefined as string | undefined,
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));

import Anthropic from "@anthropic-ai/sdk";
import {
  AiNotConfiguredError,
  createClient,
  isAiConfigured,
} from "./client.js";

describe("@platform/ai client", () => {
  beforeEach(() => {
    mockEnv.ANTHROPIC_API_KEY = undefined;
  });

  it("reports AI as unconfigured and refuses to build a client without a key", () => {
    expect(isAiConfigured()).toBe(false);
    expect(() => createClient()).toThrow(AiNotConfiguredError);
  });

  it("gives callers a stable error code to branch on", () => {
    try {
      createClient();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AiNotConfiguredError);
      expect((err as AiNotConfiguredError).code).toBe("AI_NOT_CONFIGURED");
    }
  });

  it("builds a client when the key is set", () => {
    mockEnv.ANTHROPIC_API_KEY = "sk-test";
    expect(isAiConfigured()).toBe(true);
    expect(createClient()).toBeInstanceOf(Anthropic);
  });
});
