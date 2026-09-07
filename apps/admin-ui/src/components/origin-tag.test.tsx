import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  OriginTag,
  OriginCornerBadge,
  OriginHeaderPill,
  OriginDetailLine,
} from "./origin-tag.js";

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

  it('renders "External" for mechanism api, with app name and resolved performer name', () => {
    render(
      <OriginTag
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "378676050449661954",
          performerDisplayName: "Jane Doe",
        }}
      />,
    );
    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.getByText("Acme Sync")).toBeTruthy();
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.queryByText("378676050449661954")).toBeNull();
  });

  it("falls back to the raw performer id when no display name resolved", () => {
    render(
      <OriginTag
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "jane@acme.com",
        }}
      />,
    );
    expect(screen.getByText("jane@acme.com")).toBeTruthy();
  });

  it('renders "Redirected" for mechanism handoff', () => {
    render(
      <OriginTag
        origin={{
          mechanism: "handoff",
          appName: "Acme Portal",
          performerUserId: "real-user-id",
          performerDisplayName: "Real User",
        }}
      />,
    );
    expect(screen.getByText("Redirected")).toBeTruthy();
    expect(screen.getByText("Acme Portal")).toBeTruthy();
  });
});

describe("OriginCornerBadge", () => {
  it("renders nothing when origin is null", () => {
    const { container } = render(<OriginCornerBadge origin={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders only the mechanism label, not app/person detail", () => {
    render(
      <OriginCornerBadge
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "378676050449661954",
          performerDisplayName: "Jane Doe",
        }}
      />,
    );
    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.queryByText("Acme Sync")).toBeNull();
    expect(screen.queryByText("Jane Doe")).toBeNull();
  });

  it("carries the full detail in its title tooltip", () => {
    render(
      <OriginCornerBadge
        origin={{
          mechanism: "handoff",
          appName: "Acme Portal",
          performerUserId: "real-user-id",
          performerDisplayName: "Real User",
        }}
      />,
    );
    expect(
      screen.getByTitle("Redirected · Created via Acme Portal by Real User"),
    ).toBeTruthy();
  });
});

describe("OriginHeaderPill", () => {
  it("renders nothing when origin is null", () => {
    const { container } = render(<OriginHeaderPill origin={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders only the mechanism label, matching the corner badge's compactness", () => {
    render(
      <OriginHeaderPill
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "378676050449661954",
          performerDisplayName: "Jane Doe",
        }}
      />,
    );
    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.queryByText("Acme Sync")).toBeNull();
  });
});

describe("OriginDetailLine", () => {
  it("renders nothing when origin is null", () => {
    const { container } = render(<OriginDetailLine origin={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the app name and resolved performer name for a tagged origin", () => {
    render(
      <OriginDetailLine
        origin={{
          mechanism: "api",
          appName: "Acme Sync",
          performerUserId: "378676050449661954",
          performerDisplayName: "Jane Doe",
        }}
      />,
    );
    expect(screen.getByText("Acme Sync")).toBeTruthy();
    expect(screen.getByText("Jane Doe")).toBeTruthy();
  });
});
