import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders its label and responds to a click", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>שלח</Button>);

    const button = screen.getByRole("button", { name: "שלח" });
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        שלח
      </Button>,
    );

    const button = screen.getByRole("button", { name: "שלח" });
    expect(button).toBeDisabled();

    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to a solid primary look and switches to outline for the secondary variant", () => {
    const { rerender } = render(<Button>ראשי</Button>);
    const primary = screen.getByRole("button", { name: "ראשי" });
    expect(primary.className).toContain("bg-ink");

    rerender(<Button variant="secondary">משני</Button>);
    const secondary = screen.getByRole("button", { name: "משני" });
    expect(secondary.className).toContain("border-ink");
    expect(secondary.className).not.toContain("bg-ink ");
  });

  it("defaults to type=button so it never submits an ambient form", () => {
    render(<Button>שלח</Button>);
    expect(screen.getByRole("button", { name: "שלח" })).toHaveAttribute("type", "button");
  });
});
