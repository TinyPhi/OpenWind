import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserPicker } from "./user-picker.js";

afterEach(() => cleanup());

describe("UserPicker", () => {
  it.each(["", "   "])(
    "renders the fallback initial for the selected user when the display name is %j",
    (displayName) => {
      render(
        <UserPicker
          users={[
            {
              userId: "user-1",
              displayName,
              email: "user@example.com",
            },
          ]}
          value="user-1"
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByText("U")).not.toBeNull();
    },
  );
});
