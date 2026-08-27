import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";

/**
 * Modal is stateful by nature (open/close, focus). Testing it honestly means
 * driving it through a real trigger + state, not asserting that a callback
 * was invoked — see ARCHITECTURE.md's test policy.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>פתח חלון</button>
      <Modal open={open} onClose={() => setOpen(false)} title="אישור מחיקה">
        <button>אישור</button>
        <button>ביטול</button>
      </Modal>
    </div>
  );
}

describe("Modal", () => {
  it("is not rendered at all while closed", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with correct dialog semantics and moves focus into the panel", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "פתח חלון" }));

    const dialog = screen.getByRole("dialog", { name: "אישור מחיקה" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "אישור" })).toHaveFocus();
  });

  it("closes on backdrop click and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "פתח חלון" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.previousElementSibling;
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop as Element);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "פתח חלון" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("traps Tab focus so it cycles within the panel instead of escaping it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "פתח חלון" }));

    const confirm = screen.getByRole("button", { name: "אישור" });
    const cancel = screen.getByRole("button", { name: "ביטול" });
    expect(confirm).toHaveFocus();

    await user.tab();
    expect(cancel).toHaveFocus();

    // Tab past the last focusable wraps back to the first.
    await user.tab();
    expect(confirm).toHaveFocus();

    // Shift+Tab from the first focusable wraps to the last.
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it("does not fire onClose when the panel itself is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "פתח חלון" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.click(dialog);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
