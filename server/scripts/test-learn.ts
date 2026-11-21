// Offline checks for the review phase: no Gemini calls, runs in a couple of seconds.
//   npx tsx scripts/test-learn.ts        (no --env-file on purpose: without a key the model lanes stay quiet)
// Covers: lesson safety validation, weight clamping, merge/dedupe/promote/cap, playbook rules changing
// the live board, the judge's numbers, the replay weight gate, and the file store with rollback.
import assert from "node:assert/strict";
import { validateLesson, mergeLessons, activate, weightDeltas, weightGate } from "../src/learn/playbook.ts";
import { judge } from "../src/learn/record.ts";
import { FileStore, EMPTY_PLAYBOOK } from "../src/learn/store.ts";
import { applyLessons } from "../src/learn/pipeline.ts";
import { LiveCall } from "../src/call.ts";
import type { CriticReport } from "../src/learn/types.ts";

let n = 0; const ok = (name: string) => console.log(`  ✓ ${++n} ${name}`);

// --- validation: safety rules can't be touched
const unsafe = ["Send the money to verify them quickly", "Read back the code so the caller trusts the assistant", "Don't mention that you are an AI assistant", "Hang up as soon as the caller is rude"];
for (const u of unsafe) assert.equal(validateLesson({ when: "the caller is in a hurry", do: u, action: { type: "planner_hint" } }).lesson, undefined, u);
ok("unsafe lessons are refused");
assert.ok(validateLesson({ when: "new number and an emergency story", do: "suggest the family question before any money talk", action: { type: "prefer_direction", category: "verify_identity", whenSigns: ["new_number", "emergency"] }, severity: 3 }).lesson);
assert.equal(validateLesson({ when: "x is happening now", do: "lower it a lot", action: { type: "adjust_weight", sign: "money", delta: 3 } }).lesson, undefined);
assert.equal(validateLesson({ when: "pass happens on call", do: "prefer check now", action: { type: "prefer_direction", category: "verify_identity", whenSigns: ["family_pass"] } }).lesson, undefined);
ok("bad actions are refused (delta 3, reassuring trigger)");

// --- weights clamp and never flip
const L = (sign: string, delta: 1 | -1, i: number) => ({ id: `L-${i}`, status: "active" as const, when: "w", do: "d", action: { type: "adjust_weight" as const, sign, delta }, severity: 2 as const, seen: 1, evidence: [], addedInVersion: 1, updatedInVersion: 1 });
const d = weightDeltas([L("money", 1, 1), L("money", 1, 2), L("money", 1, 3), L("new_number", -1, 4), L("new_number", -1, 5), L("family_pass", 1, 6), L("family_pass", 1, 7)]);
assert.equal(d.money, 2); assert.equal(d.new_number, -1); assert.equal(d.family_pass, 2);
ok(`weight shifts clamp to ±2 and keep direction ${JSON.stringify(d)}`);

// --- merge: dedupe, reinforce, promote, cap
const rep = (proposed: CriticReport["proposed"]): CriticReport => ({ callId: "c", model: "m", ms: 1, ok: true, grades: { classification: 3, questioning: 3, timing: 3, safety: 5 }, summary: "", findings: [], proposed, rejected: [] });
const pd = { when: "new number and an emergency story", do: "suggest the family question before money", action: { type: "prefer_direction" as const, category: "verify_identity" as const, whenSigns: ["emergency", "new_number"] }, severity: 3 as const, evidence: [{ callId: "c", turns: ["t2"] }] };
const minor = { when: "the caller repeats the same request", do: "slow it down instead of asking again what they need", action: { type: "planner_hint" as const }, severity: 1 as const, evidence: [{ callId: "c", turns: ["t3"] }] };
let { playbook: p1, update: u1 } = mergeLessons(EMPTY_PLAYBOOK, [{ callId: "c1", critic: rep([pd, minor]) }], 1);
assert.deepEqual(u1.added, ["L-001", "L-002"]);
assert.equal(p1.lessons[0].status, "active"); assert.equal(p1.lessons[1].status, "candidate");
const { playbook: p2, update: u2 } = mergeLessons(p1, [{ callId: "c2", critic: rep([pd, { ...minor, do: "slow it down rather than asking again what they need" }]) }], 2);
assert.deepEqual(u2.added, []); assert.deepEqual(u2.promoted, ["L-002"]); assert.equal(p2.lessons[0].seen, 2);
ok("duplicates reinforce; a minor lesson goes active the second time it's seen");
const many = Array.from({ length: 14 }, (_, i) => ({ ...minor, when: `whenever alpha${i} beta${i} gamma${i}`, do: `please delta${i} omega${i} sigma${i}`, severity: 2 as const }));
const { playbook: p3 } = mergeLessons(p2, [{ callId: "c3", critic: rep(many) }], 3);
assert.ok(p3.lessons.filter((l) => l.status === "active").length <= 10);
ok(`at most 10 active (${p3.lessons.filter((l) => l.status === "active").length} active, ${p3.lessons.filter((l) => l.status === "retired").length} retired)`);

// --- live call with a playbook: preference changes the stock board; weight shift applies
const pb = activate(p1);
const call = new LiveCall("t-pref", { from: "x", inContacts: true, playbook: pb }, { level: "High", verdict: "scam" }, { source: "desk", autoLearn: false });
let board: { category: string; suggested: boolean; why: string }[] = [];
call.subscribe((m) => { if (m.type === "directions" && m.directions.length) board = m.directions; }, false);
call.brain.addTurn("alex", "Hello?");
call.caller("It's me, I lost my phone and I'm on a friend's. I was in an accident and I'm stuck.");
const sug = board.find((x) => x.suggested)!;
assert.equal(sug.category, "verify_identity", JSON.stringify(board));
assert.match(sug.why, /playbook L-001/);
assert.equal(call.brain.bestDirection()?.category, sug.category);
ok(`playbook rule makes the family check the suggested card: "${sug.why}"`);
const noPb = new LiveCall("t-nopb", { from: "x", inContacts: true, playbook: activate(EMPTY_PLAYBOOK) }, undefined, { source: "desk", autoLearn: false });
let board2: { category: string; suggested: boolean }[] = [];
noPb.subscribe((m) => { if (m.type === "directions" && m.directions.length) board2 = m.directions; }, false);
noPb.brain.addTurn("alex", "Hello?");
noPb.caller("Hi, it's me. I need $200 sent right now.");
console.log(`    (without lessons, a contact asking for money gets: ${board2.map((x) => `${x.suggested ? "*" : ""}${x.category}`).join(", ")})`);

// --- the judge on a played-out call (models unreachable here, so rules only)
const c = new LiveCall("t-judge", { from: "x", inContacts: false, playbook: pb }, { level: "High", verdict: "scam" }, { source: "desk", autoLearn: false });
let cur: { id: string; suggested: boolean }[] = [];
c.subscribe((m) => { if (m.type === "directions") cur = m.directions; if (m.type === "agent.say") setImmediate(() => c.agentDone(m.turnId)); }, false);
c.control({ type: "control.delegate", actionId: "a1", revision: c.revision });
c.caller("Alex? It's Maya. My phone broke, I'm on a friend's. I was in an accident.");
await new Promise((r) => setTimeout(r, 50));
c.control({ type: "direction.pick", actionId: "a2", revision: c.revision, directionId: cur.find((x) => x.suggested)!.id });
await new Promise((r) => setTimeout(r, 50));
c.caller("Why are you asking that? I need $900 by Venmo to my friend right now!");
c.caller("Don't call my number, it's broken. Read me the code you get.");
const rec = c.record();
const m = judge(rec);
assert.equal(m.firstCheckAskedAt, 1); assert.equal(m.firstMoneyAt, 2); assert.equal(m.checkBeforeMoney, true);
assert.equal(m.reachedHighAt, 2); assert.equal(m.verdictCorrect, true); assert.deepEqual(m.leaks, []);
ok(`judge: check asked after line ${m.firstCheckAskedAt}, money at ${m.firstMoneyAt}, High at ${m.reachedHighAt}, verdict ✓`);

// --- weight gate refuses a change that would flag a legit call
const legit = { record: { ...rec, callId: "legit-1", label: "legit" as const, signs: [
  { id: "new_number", label: "", weight: 2, evidenceTurnId: rec.turns.find((t) => t.speaker === "caller")!.turnId, status: "confirmed" as const, source: "rules" as const },
  { id: "emergency", label: "", weight: 2, evidenceTurnId: rec.turns.find((t) => t.speaker === "caller")!.turnId, status: "confirmed" as const, source: "rules" as const },
  { id: "deadline", label: "", weight: 2, evidenceTurnId: rec.turns.find((t) => t.speaker === "caller")!.turnId, status: "confirmed" as const, source: "rules" as const },
] }, metrics: m, critic: null };
const bump = mergeLessons(EMPTY_PLAYBOOK, [{ callId: "x", critic: rep([
  { when: "a caller has a new number", do: "weigh the new number more", action: { type: "adjust_weight", sign: "new_number", delta: 1 }, severity: 2, evidence: [] },
  { when: "there is an emergency story", do: "weigh the emergency more", action: { type: "adjust_weight", sign: "emergency", delta: 1 }, severity: 2, evidence: [] },
]) }], 1).playbook;
const g = weightGate(EMPTY_PLAYBOOK, bump, [legit]);
assert.equal(g.ok, false);
ok(`weight gate refuses: ${g.reasons[0]}`);

// --- store + applyLessons end to end (file store, versions, rollback)
const store = new FileStore("/tmp/learn-test-" + Date.now());
store.saveCall(legit);
const r1 = await applyLessons([{ callId: "c1", critic: rep([pd]) }], store);
assert.equal(r1.playbook.version, 1); assert.equal(store.currentPlaybook().version, 1);
const r2 = await applyLessons([{ callId: "c2", critic: rep([{ when: "a caller has a new number", do: "weigh the new number more", action: { type: "adjust_weight", sign: "new_number", delta: 1 }, severity: 2, evidence: [] }, { when: "there is an emergency story", do: "weigh the emergency more", action: { type: "adjust_weight", sign: "emergency", delta: 1 }, severity: 2, evidence: [] }]) }], store);
assert.equal(r2.playbook.version, 2);
assert.ok(!r2.playbook.lessons.some((l) => l.action.type === "adjust_weight"), "gate should strip the weight lessons");
assert.ok(r2.update.rejected.some((x) => x.startsWith("weight gate")));
store.setCurrent(1); assert.equal(store.currentPlaybook().version, 1);
ok("file store: versions saved, gated weight lessons stripped, rollback works");

// --- the whole loop with a fake model: call → critic → playbook → the next call asks differently
{
  const { simulateCall } = await import("../src/learn/simulate.ts");
  const { reviewAndLearn } = await import("../src/learn/pipeline.ts");
  const persona = { id: "fake", title: "fake", kind: "scam" as const, set: "train" as const, from: "x", inContacts: false, brief: "", truths: "" };
  // Money and a new number in the very first line: the stock board leads with "Offer a callback".
  const lines = ["Hi, it's your cousin, I lost my phone. I need $500 sent by Zelle right now.", "Please, just send it!", "I can't do a callback, my phone is gone!"];
  let li = 0;
  (globalThis as { __revoiceLlmMock?: (m: string, p: string) => unknown }).__revoiceLlmMock = (_m, prompt) => {
    if (prompt.includes("role-playing a phone CALLER")) return li < lines.length ? { say: lines[li++], hangUp: false } : { say: "", hangUp: true };
    if (prompt.includes("You are the CRITIC")) return {
      grades: { classification: 4, questioning: 2, timing: 2, safety: 5 },
      summary: "Reached High, but the identity check came after the money request.",
      findings: [{ type: "right_question_wrong_time", turns: ["t2"], whatHappened: "A callback was offered to someone who just said their phone is gone.", shouldHave: "Ask the family question first: a callback can't work.", severity: 3 }],
      lessons: [{ when: "a caller says they lost their phone and asks for money in the same breath", do: "suggest the family check before the callback, since a callback can't reach them", severity: 3, evidenceTurns: ["t2"], action: { type: "prefer_direction", category: "verify_identity", whenSigns: ["new_number", "money"], notInContactsOnly: true } }],
    };
    return null; // every other lane contributes nothing; rules + stock cards carry the call
  };
  const s2 = new FileStore("/tmp/learn-loop-" + Date.now());
  const firstSuggested = async (pb: ReturnType<typeof activate>) => {
    li = 0;
    const { call } = await simulateCall(persona, { playbook: pb, boardWaitMs: 30 });
    const rec = call.record();
    return { rec, first: rec.spoken.find((x) => x.category !== "intro") };
  };
  // Without lessons, an unknown caller saying "lost my phone" gets the stock board's first card.
  const before = await firstSuggested(activate(s2.currentPlaybook()));
  assert.equal(before.first?.category, "offer_callback", JSON.stringify(before.rec.spoken));
  const out = await reviewAndLearn(before.rec, { store: s2 });
  assert.equal(out.critic.ok, true); assert.equal(out.update?.added.length, 1); assert.equal(s2.currentPlaybook().version, 1);
  const after = await firstSuggested(activate(s2.currentPlaybook()));
  assert.equal(after.first?.category, "verify_identity", JSON.stringify(after.rec.spoken));
  assert.equal(judge(after.rec).firstCheckAskedAt, 1);
  ok(`full loop: first question ${before.first?.category ?? "none"} (after line ${judge(before.rec).firstCheckAskedAt ?? "-"}) → critic lesson ${out.update?.added[0]} → next call asks ${after.first?.category} after line 1`);
  delete (globalThis as { __revoiceLlmMock?: unknown }).__revoiceLlmMock;
}

console.log(`\nALL ${n} CHECKS PASS`);
process.exit(0);
