import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionHeading } from "./SectionHeading";

describe("SectionHeading", () => {
  it("renders the heading text as a level-2 heading by default", () => {
    render(<SectionHeading>יצירות נבחרות</SectionHeading>);
    const heading = screen.getByRole("heading", { level: 2, name: "יצירות נבחרות" });
    expect(heading).toBeInTheDocument();
  });

  it("renders a much longer heading without breaking", () => {
    const longTitle = "כותרת ארוכה מאוד שנועדה לבדוק שהרכיב עובד גם עם טקסט ארוך במיוחד שמותח את הרוחב";
    render(<SectionHeading>{longTitle}</SectionHeading>);
    expect(screen.getByRole("heading", { name: longTitle })).toBeInTheDocument();
  });

  it("supports rendering as a different heading level via the as prop", () => {
    render(<SectionHeading as="h1">כותרת ראשית</SectionHeading>);
    expect(screen.getByRole("heading", { level: 1, name: "כותרת ראשית" })).toBeInTheDocument();
  });
});
