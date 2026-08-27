/**
 * Picking taxonomy values.
 *
 * The closed set, rendered. design/Upload.dc.html shows each axis as a row of
 * `.tag` chips with the chosen ones filled in, and the shared `Badge`'s
 * `tag` / `tag-selected` variants are exactly that treatment.
 *
 * The options come from the module's own constants, so an artist is never shown
 * a value the server would reject and never denied one it would accept. That is
 * the honest reading of "the taxonomy is a closed, server-defined set": the
 * client does not get its own list.
 *
 * The cap is enforced here as well as on the server (SECURITY.md S2-20, "cap
 * the shape"). Not because the client is trusted -- it is not, and the server
 * refuses an over-cap submission regardless -- but because a chip that silently
 * does nothing is worse than one that is visibly unavailable.
 */
"use client";

import { Badge } from "@/shared/ui";

export interface TaxonomyOption {
  readonly value: string;
  readonly label: string;
}

export interface TaxonomyPickerProps {
  readonly axis: string;
  readonly legend: string;
  readonly options: readonly TaxonomyOption[];
  readonly selected: readonly string[];
  /** Omit for a single-select axis such as medium. */
  readonly max?: number;
  readonly onChange: (values: readonly string[]) => void;
  readonly error?: string;
}

export function TaxonomyPicker({
  axis,
  legend,
  options,
  selected,
  max,
  onChange,
  error,
}: TaxonomyPickerProps) {
  const single = max === undefined;
  const atCap = !single && selected.length >= max;

  const toggle = (value: string): void => {
    if (single) {
      onChange(selected.includes(value) ? [] : [value]);
      return;
    }
    if (selected.includes(value)) {
      onChange(selected.filter((chosen) => chosen !== value));
      return;
    }
    if (atCap) return;
    onChange([...selected, value]);
  };

  const errorId = error ? `${axis}-error` : undefined;

  return (
    <fieldset aria-describedby={errorId}>
      <legend className="caps mb-2 text-[13px] tracking-[0.14em] text-ink-soft">{legend}</legend>

      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const chosen = selected.includes(option.value);
          // Disabled only when the cap is reached AND this chip is not already
          // chosen -- otherwise an artist at the cap could not deselect
          // anything, which is the one thing they need to do next.
          const unavailable = !chosen && atCap;

          return (
            <button
              key={option.value}
              type="button"
              // `aria-pressed` rather than a checkbox role: these are toggles,
              // and a screen reader should say "pressed", not "checked".
              aria-pressed={chosen}
              disabled={unavailable}
              onClick={() => toggle(option.value)}
              className="rounded-none disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <Badge variant={chosen ? "tag-selected" : "tag"}>{option.label}</Badge>
            </button>
          );
        })}
      </div>

      {max !== undefined ? (
        <p className="mt-2 text-xs text-ink-muted">{`ניתן לבחור עד ${max}`}</p>
      ) : null}

      {error ? (
        <p id={errorId} className="mt-2 text-xs text-alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
