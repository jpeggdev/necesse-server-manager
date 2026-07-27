import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Splitter } from "../src/Splitter";

function setup(width = 400, overrides: Partial<Parameters<typeof Splitter>[0]> = {}) {
  const onResize = vi.fn();
  render(<Splitter width={width} min={300} max={900} onResize={onResize} {...overrides} />);
  return { onResize, handle: screen.getByRole("separator") };
}

describe("Splitter", () => {
  it("exposes its current and permitted range to assistive tech", () => {
    const { handle } = setup(432);
    expect(handle).toHaveAttribute("aria-valuenow", "432");
    expect(handle).toHaveAttribute("aria-valuemin", "300");
    expect(handle).toHaveAttribute("aria-valuemax", "900");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("is keyboard reachable and resizes with the arrow keys", async () => {
    const { onResize, handle } = setup(400);
    handle.focus();
    expect(handle).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(416);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onResize).toHaveBeenLastCalledWith(384);
  });

  it("clamps at the maximum rather than reporting an out-of-range width", async () => {
    const { onResize, handle } = setup(895);
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(900);
  });

  it("clamps at the minimum rather than reporting an out-of-range width", async () => {
    const { onResize, handle } = setup(305);
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it("ignores keys that are not a horizontal resize", async () => {
    const { onResize, handle } = setup();
    handle.focus();
    await userEvent.keyboard("{ArrowUp}{Enter}a");
    expect(onResize).not.toHaveBeenCalled();
  });
});
