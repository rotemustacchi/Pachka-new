import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Harness() {
  const { show } = useToast();
  return (
    <button
      onClick={() => {
        show("ההזמנה נשלחה בהצלחה", "success");
      }}
    >
      בצע פעולה
    </button>
  );
}

describe("ToastProvider / useToast", () => {
  it("renders no toast content until one is triggered", () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    expect(screen.queryByText("ההזמנה נשלחה בהצלחה")).not.toBeInTheDocument();
  });

  it("announces a triggered toast inside a live region", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "בצע פעולה" }));

    const message = await screen.findByText("ההזמנה נשלחה בהצלחה");
    const liveRegion = message.closest('[aria-live]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
  });

  it("lets the user dismiss a toast by closing it", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "בצע פעולה" }));
    await screen.findByText("ההזמנה נשלחה בהצלחה");

    await user.click(screen.getByRole("button", { name: "סגירה" }));

    expect(screen.queryByText("ההזמנה נשלחה בהצלחה")).not.toBeInTheDocument();
  });

  it("throws a clear error when used outside a provider", () => {
    function Orphan() {
      useToast();
      return null;
    }

    // Suppress React's expected error-boundary console noise for this case.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow("useToast must be used within a ToastProvider");
    spy.mockRestore();
  });
});
