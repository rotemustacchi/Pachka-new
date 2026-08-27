import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, SoldOverlay } from "./Badge";

describe("Badge", () => {
  it("renders the tag label as plain text", () => {
    render(<Badge variant="tag">מינימליסטי</Badge>);
    expect(screen.getByText("מינימליסטי")).toBeInTheDocument();
  });

  it("gives the selected tag a filled, inverted look distinct from the default tag", () => {
    render(
      <>
        <Badge variant="tag">אבסטרקטי</Badge>
        <Badge variant="tag-selected">מינימליסטי</Badge>
      </>,
    );

    const unselected = screen.getByText("אבסטרקטי");
    const selected = screen.getByText("מינימליסטי");
    expect(unselected.className).toContain("bg-card");
    expect(selected.className).toContain("bg-ink");
  });

  it("renders the AI-assistance corner label", () => {
    render(<Badge variant="ai">נוצר בעזרת AI</Badge>);
    expect(screen.getByText("נוצר בעזרת AI")).toBeInTheDocument();
  });
});

describe("SoldOverlay", () => {
  it("dims the wrapped content and shows the sold pill over it", () => {
    render(
      <SoldOverlay>
        <p>נוף פנימי</p>
      </SoldOverlay>,
    );

    expect(screen.getByText("נוף פנימי")).toBeInTheDocument();
    expect(screen.getByText("נמכר")).toBeInTheDocument();
  });
});
