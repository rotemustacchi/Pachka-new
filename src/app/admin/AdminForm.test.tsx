/**
 * The admin form shell.
 *
 * The banner is what matters. An admin action either happened or was refused,
 * and both answers have to be visible and announced — a takedown that silently
 * failed and a takedown that silently succeeded look identical on a page that
 * says nothing, and the difference is whether an artist's work is still for
 * sale.
 *
 * The refusal wording is the module's and is asserted verbatim elsewhere
 * (tests/integration/routes-admin.test.ts); here the question is only whether
 * the shell shows what it is given.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminForm } from "./AdminForm";
import { IDLE, type FormState } from "../_lib/form-state";

const idle = async (): Promise<FormState> => IDLE;

describe("the admin form shell", () => {
  it("renders its title, its fields and a submit button", () => {
    render(
      <AdminForm action={idle} title="הסרת היצירה" submitLabel="הסרה">
        {() => <input aria-label="סיבה" name="reason" />}
      </AdminForm>,
    );

    expect(screen.getByRole("heading", { name: "הסרת היצירה" })).toBeInTheDocument();
    expect(screen.getByLabelText("סיבה")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "הסרה" })).toHaveAttribute("type", "submit");
  });

  it("shows nothing before anything has been submitted", () => {
    render(
      <AdminForm action={idle} title="השעיה" submitLabel="השעיה">
        {() => null}
      </AdminForm>,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("announces a refusal, and hands it to the fields so it can be shown per field", async () => {
    // The message a non-admin gets is the module's, unchanged: "Not found".
    const refused: FormState = {
      status: "error",
      message: "Not found",
      fields: { reason: ["חובה"] },
    };

    render(
      <AdminForm action={async () => refused} title="הסרה" submitLabel="הסרה">
        {(state) => <p>{state.fields?.reason?.[0] ?? "—"}</p>}
      </AdminForm>,
    );

    await userEvent.click(screen.getByRole("button", { name: "הסרה" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Not found");
    expect(screen.getByText("חובה")).toBeInTheDocument();
  });

  it("announces a success the same way, so neither outcome is silent", async () => {
    render(
      <AdminForm
        action={async () => ({ status: "ok", message: "היצירה הוסרה." })}
        title="הסרה"
        submitLabel="הסרה"
      >
        {() => null}
      </AdminForm>,
    );

    await userEvent.click(screen.getByRole("button", { name: "הסרה" }));

    expect(await screen.findByRole("status")).toHaveTextContent("היצירה הוסרה.");
  });
});
