import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OriginTag, OriginBanner } from "./origin-tag.js";

afterEach(cleanup);

describe("OriginTag", () => {
  it("renders nothing when origin is null", () => {
    const { container } = render(<OriginTag origin={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when origin is undefined", () => {
    const { container } = render(<OriginTag origin={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "External" for mechanism api, with app name and performer', () => {
    render(
      <OriginTag
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "jane@acme.com",
        }}
      />,
    );
    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.getByText("Acme Sync")).toBeTruthy();
    expect(screen.getByText("jane@acme.com")).toBeTruthy();
  });

  it('renders "Redirected" for mechanism handoff', () => {
    render(
      <OriginTag
        origin={{
          mechanism: "handoff",
          appName: "Acme Portal",
          performerUserId: "real-user-id",
        }}
      />,
    );
    expect(screen.getByText("Redirected")).toBeTruthy();
    expect(screen.getByText("Acme Portal")).toBeTruthy();
  });
});

describe("OriginBanner", () => {
  it("renders nothing when origin is null", () => {
    const { container } = render(<OriginBanner origin={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the app name and performer for a tagged origin", () => {
    render(
      <OriginBanner
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "jane@acme.com",
        }}
      />,
    );
    expect(screen.getByText("Acme Sync")).toBeTruthy();
    expect(screen.getByText("jane@acme.com")).toBeTruthy();
  });
});
