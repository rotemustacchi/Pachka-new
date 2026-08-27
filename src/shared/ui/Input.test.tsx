import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Input } from "./Input";

describe("Input", () => {
  it("associates the visible label with the field", async () => {
    const user = userEvent.setup();
    render(<Input label="שם מלא" />);

    const input = screen.getByLabelText("שם מלא");
    await user.type(input, "נועה");

    expect(input).toHaveValue("נועה");
  });

  it("marks the field invalid and announces the error via aria-describedby", () => {
    render(<Input label="דוא״ל" error="כתובת דוא״ל לא תקינה" />);

    const input = screen.getByLabelText("דוא״ל");
    expect(input).toHaveAttribute("aria-invalid", "true");

    const errorMessage = screen.getByText("כתובת דוא״ל לא תקינה");
    expect(errorMessage).toHaveAttribute("role", "alert");

    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(describedBy).toContain(errorMessage.id);
  });

  it("has no aria-invalid attribute when there is no error", () => {
    render(<Input label="עיר" hint="לדוגמה: תל אביב" />);
    const input = screen.getByLabelText("עיר");
    expect(input).not.toHaveAttribute("aria-invalid");

    const hint = screen.getByText("לדוגמה: תל אביב");
    expect(input.getAttribute("aria-describedby")).toContain(hint.id);
  });
});
