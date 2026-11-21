import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flagTurn } from "../src/brain/rules.ts";

describe("flagTurn", () => {
  it("flags money and third_party_pay on a tow/Venmo ask", () => {
    const hits = flagTurn("$900 for the tow. Venmo it to my friend Jordan");
    assert.ok(hits.includes("money"));
    assert.ok(hits.includes("third_party_pay"));
  });

  it("does not flag money on a neutral purchase mention", () => {
    const hits = flagTurn("a $64 purchase at a gas station");
    assert.ok(!hits.includes("money"));
  });

  it("does not flag code when negated as reassurance", () => {
    const hits = flagTurn("we will never ask for your PIN");
    assert.ok(!hits.includes("code"));
  });

  it("flags code on a request for a six-digit code", () => {
    const hits = flagTurn("read me the six-digit code");
    assert.ok(hits.includes("code"));
  });

  it("flags urgency, emergency, new number, secrecy, and callback refusal", () => {
    assert.ok(flagTurn("I was in an accident and need help right now").includes("emergency"));
    assert.ok(flagTurn("I was in an accident and need help right now").includes("deadline"));
    assert.ok(flagTurn("I lost my phone, calling from a friend's phone").includes("new_number"));
    assert.ok(flagTurn("Please don't tell Mom about this").includes("secrecy"));
    assert.ok(flagTurn("No, don't call me back, stay on the line").includes("callback_refused"));
  });
});
