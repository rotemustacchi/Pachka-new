/**
 * Rotation: the two requirements that pull against each other.
 *
 * "Ranking is reproducible within a rotation epoch" and "no single artwork
 * holds the top tie position permanently" are both in the spec, and an
 * implementation can satisfy either one alone trivially — freeze the order, or
 * shuffle it. Satisfying both at once is the whole design, so both are asserted
 * here against the same function.
 *
 * The artwork ids are fixed rather than random. A rotation test over random
 * UUIDs either passes for the wrong reason or fails one run in fifty, and a
 * flaky test about fairness is worse than none.
 */
import { describe, expect, it } from "vitest";
import { orderTieBand, rotationEpochAt, rotationKey } from "./rotation";

const IDS = [
  "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  "cccccccc-3333-4333-8333-cccccccccccc",
] as const;

describe("the rotation epoch", () => {
  it("advances exactly on the period boundary and not before", () => {
    const justBefore = rotationEpochAt(new Date("2026-09-01T23:59:59.999Z"), 24);
    const justAfter = rotationEpochAt(new Date("2026-09-02T00:00:00.000Z"), 24);

    expect(justAfter.index).toBe(justBefore.index + 1);
    expect(justBefore.startedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(justAfter.startedAt.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("gives the same epoch for every instant inside one period", () => {
    const morning = rotationEpochAt(new Date("2026-09-01T06:30:00.000Z"), 24);
    const evening = rotationEpochAt(new Date("2026-09-01T21:45:12.000Z"), 24);

    expect(morning.index).toBe(evening.index);
    expect(morning.startedAt.getTime()).toBe(evening.startedAt.getTime());
  });

  it("refuses a period that is not a positive number of hours", () => {
    expect(() => rotationEpochAt(new Date(), 0)).toThrow(/must be positive/);
  });
});

describe("the rotation key", () => {
  it("is stable for the same epoch and artwork, across calls", () => {
    const epoch = rotationEpochAt(new Date("2026-09-01T10:00:00.000Z"), 24);

    expect(rotationKey(epoch, IDS[0])).toBe(rotationKey(epoch, IDS[0]));
  });

  it("differs between epochs for the same artwork", () => {
    const first = rotationEpochAt(new Date("2026-09-01T10:00:00.000Z"), 24);
    const second = rotationEpochAt(new Date("2026-09-02T10:00:00.000Z"), 24);

    expect(rotationKey(first, IDS[0])).not.toBe(rotationKey(second, IDS[0]));
  });

  it("differs between artworks within one epoch", () => {
    const epoch = rotationEpochAt(new Date("2026-09-01T10:00:00.000Z"), 24);

    expect(rotationKey(epoch, IDS[0])).not.toBe(rotationKey(epoch, IDS[1]));
  });
});

describe("a tie band", () => {
  it("is ordered identically every time it is ranked within one epoch", () => {
    const epoch = rotationEpochAt(new Date("2026-09-01T03:00:00.000Z"), 24);

    const first = orderTieBand(epoch, IDS);
    const second = orderTieBand(epoch, [...IDS].reverse());

    // Note the reversed input: the output must depend on the epoch and the ids,
    // not on the order they happened to arrive in.
    expect(second).toEqual(first);
    expect(orderTieBand(epoch, IDS)).toEqual(first);
  });

  it("does not leave the same artwork at the top for ever", () => {
    // Thirty consecutive epochs — a month at the default period. If one artwork
    // held the top tie position in all thirty, the rotation would not be
    // rotating and the spec's "no single artwork holds the top tie position
    // permanently" would be false.
    const leaders = new Set<string>();
    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);
      leaders.add(orderTieBand(epoch, IDS)[0] ?? "");
    }

    expect(leaders.size).toBeGreaterThan(1);
  });

  it("gives every artwork in a three-way tie a turn at the top over a month", () => {
    // Stronger than the spec requires, and the property an artist would
    // actually care about: rotation that only ever alternates between two of
    // three pieces is still permanently unfair to the third.
    const leaders = new Set<string>();
    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);
      leaders.add(orderTieBand(epoch, IDS)[0] ?? "");
    }

    expect(leaders).toEqual(new Set(IDS));
  });

  it("orders a band of one without incident", () => {
    const epoch = rotationEpochAt(new Date("2026-09-01T00:00:00.000Z"), 24);

    expect(orderTieBand(epoch, [IDS[0]])).toEqual([IDS[0]]);
    expect(orderTieBand(epoch, [])).toEqual([]);
  });
});
