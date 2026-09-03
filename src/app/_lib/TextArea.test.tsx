/**
 * The multi-line field.
 *
 * The interesting part is the wiring an artist using a screen reader depends
 * on: the label has to point at the control, and an error has to be announced
 * and associated rather than merely painted red. `Input.test.tsx` asserts the
 * same properties for the single-line control this one is modelled on.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextArea } from "./TextArea";

describe("the multi-line field", () => {
  it("associates its label with the control", () => {
    render(<TextArea label="תיאור" name="description" />);

    expect(screen.getByLabelText("תיאור")).toHaveAttribute("name", "description");
  });

  it("announces an error and points the control at it", () => {
    render(<TextArea label="הערת מנהל" error="חובה" />);

    const field = screen.getByLabelText("הערת מנהל");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("חובה");
    expect(screen.getByRole("alert")).toHaveTextContent("חובה");
  });

  it("shows a hint when there is no error, and stands aside when there is", () => {
    const { rerender } = render(<TextArea label="הערה" hint="ייראה בתיעוד" />);
    expect(screen.getByLabelText("הערה")).toHaveAccessibleDescription("ייראה בתיעוד");

    rerender(<TextArea label="הערה" hint="ייראה בתיעוד" error="חובה" />);
    expect(screen.getByLabelText("הערה")).toHaveAccessibleDescription("חובה");
  });
});
