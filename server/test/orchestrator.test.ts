import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SingleFlight } from "../src/brain/orchestrator.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

describe("SingleFlight", () => {
  it("runs at most one job in flight and collapses concurrent kicks into a single rerun", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    const gates: ReturnType<typeof deferred>[] = [];

    const sf = new SingleFlight(
      async () => {
        runs++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        inFlight--;
      },
      () => true,
    );

    // Kick once to start run 1, then kick multiple times while run 1 is still in flight.
    sf.kick();
    sf.kick();
    sf.kick();
    sf.kick();

    assert.equal(runs, 1);
    assert.equal(inFlight, 1);

    // Finish run 1: all extra kicks must collapse into exactly one rerun (run 2).
    gates[0].resolve();
    await flushMicrotasks();

    assert.equal(runs, 2);
    assert.equal(inFlight, 1);
    assert.equal(maxInFlight, 1);

    // Finish run 2 with no more kicks: should go idle with no run 3.
    gates[1].resolve();
    await flushMicrotasks();

    assert.equal(runs, 2);
    assert.equal(inFlight, 0);
  });

  it("does not rerun after alive() returns false", async () => {
    let alive = true;
    let runs = 0;
    const gate = deferred();

    const sf = new SingleFlight(
      async () => {
        runs++;
        await gate.promise;
      },
      () => alive,
    );

    sf.kick();
    sf.kick(); // queues a pending rerun
    alive = false;

    gate.resolve();
    await flushMicrotasks();

    assert.equal(runs, 1);
  });
});
