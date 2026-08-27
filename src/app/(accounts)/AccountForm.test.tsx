/**
 * The account-form shell.
 *
 * The banner is the interesting part. Registration's whole design is that a
 * taken address and a free one produce the same response, and the banner is
 * where that response is shown — so it has to render a success message just as
 * prominently as a failure, and it must announce itself to a screen reader
 * rather than silently appearing.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountForm, FormMessage } from "./AccountForm";
import { IDLE, type FormState } from "./actions";

describe("the form banner", () => {
  it("shows nothing before the form has been submitted", () => {
    const { container } = render(<FormMessage state={IDLE} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("announces a success message to assistive technology", () => {
    const state: FormState = { status: "ok", message: "Check your email." };

    render(<FormMessage state={state} />);

    expect(screen.getByRole("status")).toHaveTextContent("Check your email.");
  });

  it("announces a failure the same way, so neither outcome is silent", () => {
    const state: FormState = { status: "error", message: "Email or password is incorrect." };

    render(<FormMessage state={state} />);

    expect(screen.getByRole("status")).toHaveTextContent("Email or password is incorrect.");
  });

  it("shows nothing when a state carries no message", () => {
    const { container } = render(<FormMessage state={{ status: "ok" }} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("the form shell", () => {
  const noop = async (): Promise<FormState> => IDLE;

  it("renders its fields and its submit button", () => {
    render(
      <AccountForm action={noop} submitLabel="יצירת חשבון">
        {() => <input aria-label="כתובת אימייל" name="email" />}
      </AccountForm>,
    );

    expect(screen.getByLabelText("כתובת אימייל")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "יצירת חשבון" })).toBeInTheDocument();
  });

  it("hands the current state to its fields, so errors can be rendered per field", () => {
    render(
      <AccountForm action={noop} submitLabel="שליחה">
        {(state) => <p>{state.status}</p>}
      </AccountForm>,
    );

    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("submits with a real form action rather than a click handler", () => {
    // Progressive enhancement: the form works before hydration. A click handler
    // would not.
    const { container } = render(
      <AccountForm action={noop} submitLabel="שליחה">
        {() => null}
      </AccountForm>,
    );

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(screen.getByRole("button", { name: "שליחה" })).toHaveAttribute("type", "submit");
  });
});
