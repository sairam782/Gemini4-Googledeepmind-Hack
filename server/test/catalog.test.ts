import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sign, SignStatus } from "../../shared/brain.ts";
import { guardSay, INTRO, levelFor, scoreRisk, SIGNS, STOCK } from "../src/brain/catalog.ts";

function makeSign(id: string, status: SignStatus = "confirmed"): Sign {
  const def = SIGNS[id];
  assert.ok(def, `unknown sign id: ${id}`);
  return {
    id,
    label: def.label,
    weight: def.weight,
    evidenceTurnId: "t1",
    status,
    source: status === "confirmed" ? "supervisor" : "rules",
    ...(status === "confirmed" ? { confirmedBy: "supervisor" } : {}),
  };
}

describe("guardSay", () => {
  it("blocks 4-8 digit codes while allowing dollar amounts like $900", () => {
    assert.ok(guardSay("Can you confirm 4829?"));
    assert.ok(guardSay("Try 482910."));
    assert.ok(guardSay("Reference 12345678."));
    assert.equal(guardSay("Alex heard you mention $900. Who is calling?"), null);
    assert.equal(guardSay("Alex heard you mention $1,200."), null);
    assert.equal(guardSay("Alex heard you mention $1200."), null);
  });

  it("blocks approvals", () => {
    assert.ok(guardSay("Alex approves that."));
    assert.ok(guardSay("Go ahead and run it."));
    assert.ok(guardSay("You have Alex's permission."));
    assert.ok(guardSay("I authorize the payment."));
    assert.ok(guardSay("Sounds like a deal."));
  });

  it("blocks payment commitments", () => {
    assert.ok(guardSay("Alex will send the money shortly."));
    assert.ok(guardSay("I'll wire the funds now."));
    assert.ok(guardSay("We can Venmo you right away."));
    assert.ok(guardSay("Alex can pay that today."));
  });

  it("blocks sharing codes", () => {
    assert.ok(guardSay("The code is on the screen."));
    assert.ok(guardSay("Here's the code you need."));
    assert.ok(guardSay("The password is on file."));
    assert.ok(guardSay("The PIN is written down."));
  });

  it("blocks leaked analysis", () => {
    assert.ok(guardSay("The risk score is elevated."));
    assert.ok(guardSay("This looks like a scam."));
    assert.ok(guardSay("My private notes mention a warning sign."));
  });

  it("blocks speaking as Alex or family", () => {
    assert.ok(guardSay("What is our family dog's name?"));
    assert.ok(guardSay("What was the street we lived on when we were kids?"));
    assert.ok(guardSay("Where did we all grew up?"));
    assert.ok(guardSay("What is my mom's name?"));
    assert.ok(guardSay("Let's keep this between us."));
  });

  it("blocks ending the call", () => {
    assert.ok(guardSay("I am going to end this call now."));
    assert.ok(guardSay("Please hang up the call."));
    assert.ok(guardSay("I will disconnect the call."));
  });

  it("blocks empty or overly long lines", () => {
    assert.ok(guardSay("   "));
    assert.ok(guardSay("a".repeat(241)));
  });

  it("allows every STOCK say, INTRO, and safe third-person family check", () => {
    for (const s of STOCK) {
      assert.equal(guardSay(s.say), null, `STOCK "${s.key}" should pass guardSay`);
    }
    assert.equal(guardSay(INTRO), null);
    assert.equal(
      guardSay("Alex asked me to check: what was the name of Alex's first pet?"),
      null,
    );
  });
});

describe("levelFor", () => {
  it("maps 0-3 to Low, 4-7 to Medium, and 8+ to High", () => {
    for (const n of [-5, 0, 1, 2, 3]) assert.equal(levelFor(n), "Low");
    for (const n of [4, 5, 6, 7]) assert.equal(levelFor(n), "Medium");
    for (const n of [8, 9, 15]) assert.equal(levelFor(n), "High");
  });
});

describe("scoreRisk", () => {
  it("locks on confirmed High + (family_fail or callback_refused) + (money or code)", () => {
    const viaFamilyAndMoney = scoreRisk(
      [makeSign("money"), makeSign("family_fail"), makeSign("emergency")],
      false,
    );
    assert.equal(viaFamilyAndMoney.score, 8);
    assert.equal(viaFamilyAndMoney.level, "High");
    assert.equal(viaFamilyAndMoney.locked, true);
    assert.equal(viaFamilyAndMoney.provisional, false);

    const viaCallbackAndCode = scoreRisk(
      [makeSign("code"), makeSign("callback_refused"), makeSign("deadline")],
      false,
    );
    assert.equal(viaCallbackAndCode.score, 9);
    assert.equal(viaCallbackAndCode.level, "High");
    assert.equal(viaCallbackAndCode.locked, true);
  });

  it("does not lock without all three conditions confirmed", () => {
    // Confirmed High + money + code, but no failed family check or refused callback.
    const noCheckFailure = scoreRisk(
      [makeSign("code"), makeSign("money"), makeSign("emergency")],
      false,
    );
    assert.equal(noCheckFailure.level, "High");
    assert.equal(noCheckFailure.locked, false);

    // Confirmed High + failed checks, but no money or code ask.
    const noAsk = scoreRisk(
      [makeSign("family_fail"), makeSign("callback_refused"), makeSign("emergency")],
      false,
    );
    assert.equal(noAsk.level, "High");
    assert.equal(noAsk.locked, false);

    // Confirmed family_fail + money is only 6 (Medium), not High.
    const onlyMedium = scoreRisk([makeSign("family_fail"), makeSign("money")], false);
    assert.equal(onlyMedium.level, "Medium");
    assert.equal(onlyMedium.locked, false);
  });

  it("never locks on provisional signs alone", () => {
    const provOnly = scoreRisk(
      [
        makeSign("code", "provisional"),
        makeSign("money", "provisional"),
        makeSign("family_fail", "provisional"),
      ],
      false,
    );
    assert.equal(provOnly.score, 10);
    assert.equal(provOnly.level, "High");
    assert.equal(provOnly.provisional, true);
    assert.equal(provOnly.locked, false);

    // Confirmed Medium + provisional bump to High still must not lock.
    const mixed = scoreRisk(
      [
        makeSign("money", "confirmed"),
        makeSign("family_fail", "confirmed"),
        makeSign("emergency", "provisional"),
      ],
      false,
    );
    assert.equal(mixed.score, 8);
    assert.equal(mixed.level, "High");
    assert.equal(mixed.provisional, true);
    assert.equal(mixed.locked, false);
  });

  it("stays locked once locked even if the score drops", () => {
    const dropped = scoreRisk([makeSign("family_pass"), makeSign("callback_accepted")], true);
    assert.equal(dropped.score, -9);
    assert.equal(dropped.level, "High");
    assert.equal(dropped.locked, true);
  });

  it("ignores removed signs in both score and lock evaluation", () => {
    const removed = scoreRisk(
      [
        makeSign("code", "removed"),
        makeSign("money", "removed"),
        makeSign("family_fail", "removed"),
      ],
      false,
    );
    assert.equal(removed.score, 0);
    assert.equal(removed.level, "Low");
    assert.equal(removed.locked, false);
    assert.equal(removed.provisional, false);
  });
});
