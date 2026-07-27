import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBanner } from "../src/ErrorBanner";

describe("ErrorBanner", () => {
  it("renders nothing when there is no error", () => {
    const { container } = render(<ErrorBanner error={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the daemon's own message text verbatim", () => {
    render(<ErrorBanner error="Cannot change mods while the server is running. Stop it first." onDismiss={vi.fn()} />);
    expect(
      screen.getByText("Cannot change mods while the server is running. Stop it first."),
    ).toBeTruthy();
  });

  it("dismisses on click", async () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner error="Boom" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
