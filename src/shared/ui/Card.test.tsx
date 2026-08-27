import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders its children inside a bordered surface", () => {
    render(
      <Card data-testid="card">
        <p>אגרטל חימר, ידני</p>
      </Card>,
    );

    expect(screen.getByText("אגרטל חימר, ידני")).toBeInTheDocument();
    expect(screen.getByTestId("card").className).toContain("border-rule");
  });

  it("merges a caller-supplied className instead of replacing the base style", () => {
    render(<Card className="relative">content</Card>);
    const card = screen.getByText("content");
    expect(card.className).toContain("border-rule");
    expect(card.className).toContain("relative");
  });
});
