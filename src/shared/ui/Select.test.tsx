import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Select } from "./Select";

const MEDIUM_OPTIONS = [
  { value: "painting", label: "ציור ואיור" },
  { value: "ceramics", label: "קרמיקה ואובייקטים" },
];

describe("Select", () => {
  it("associates the label with the field and lets the user choose an option", async () => {
    const user = userEvent.setup();
    render(<Select label="מדיום" options={MEDIUM_OPTIONS} />);

    const select = screen.getByLabelText("מדיום") as HTMLSelectElement;
    await user.selectOptions(select, "ceramics");

    expect(select.value).toBe("ceramics");
    expect(screen.getByRole("option", { name: "קרמיקה ואובייקטים" }).selected).toBe(true);
  });

  it("marks the field invalid and announces the error", () => {
    render(<Select label="מדיום" options={MEDIUM_OPTIONS} error="יש לבחור מדיום" />);

    const select = screen.getByLabelText("מדיום");
    expect(select).toHaveAttribute("aria-invalid", "true");

    const errorMessage = screen.getByText("יש לבחור מדיום");
    expect(errorMessage).toHaveAttribute("role", "alert");
    expect(select.getAttribute("aria-describedby")).toContain(errorMessage.id);
  });
});
