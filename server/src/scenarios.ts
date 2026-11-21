import type { ScenarioInfo } from "../../shared/brain.ts";

/**
 * Scripted calls that stand in for Twilio. Each line is what the caller says next;
 * the agent's lines come from Alex's taps. Built from the excerpts in the team's test-data page.
 */
export interface Scenario extends Omit<ScenarioInfo, "lines"> {
  script: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "maya",
    title: "Sister in trouble (v3 demo)",
    kind: "scam",
    caller: "Maya?",
    from: "+1 (917) 555-0143",
    inContacts: false,
    expected: { level: "High", verdict: "Scam: family-emergency script" },
    script: [
      "Alex? It's Maya. My phone broke, I'm on a friend's.",
      "I've been in a car accident. I'm okay, but I'm stuck and I really need help.",
      "$900 for the tow. Venmo it to my friend Jordan, it has to be in the next ten minutes.",
      "Why are you asking me that? There's no time for questions, please!",
      "Don't call my number, it's broken! Just send it to Jordan.",
      "Alex is going to get a text with a six-digit code. Read it to me so the payment goes through.",
      "Fine. Forget it.",
    ],
  },
  {
    id: "priya",
    title: "Cousin needs Zelle (v2 demo)",
    kind: "scam",
    caller: "Priya?",
    from: "+1 (646) 555-0199",
    inContacts: false,
    expected: { level: "High", verdict: "Scam: urgent money to a third party, code request" },
    script: [
      "It's Priya, your cousin. I lost my phone, I'm on a friend's.",
      "I need $200 by Zelle to my friend's account, right now.",
      "Don't call it, there's no time! Just read me the six-digit code.",
      "...forget it.",
    ],
  },
  {
    id: "mom-800",
    title: "\"Mom, don't tell Dad\"",
    kind: "scam",
    caller: "Unknown",
    from: "+1 (332) 555-0110",
    inContacts: false,
    expected: { level: "High", verdict: "Scam: urgency, secrecy, dodged safe word" },
    script: [
      "Mom, it's me. I lost my phone and I'm on a friend's. I need $800 now.",
      "Please don't tell Dad, okay? He'll freak out.",
      "There's no time for that! Just send it to this account, I'll text you the number.",
    ],
  },
  {
    id: "bank-impostor",
    title: "Fake bank fraud department",
    kind: "scam",
    caller: "\"Fraud department\"",
    from: "+1 (800) 555-0177",
    inContacts: false,
    expected: { level: "High", verdict: "Scam: bank impostor asking for a code" },
    script: [
      "This is the fraud department at your bank. We've detected a suspicious charge of $1,240 on your account.",
      "To stop it we need to verify you. We just texted a code, please read it back to me.",
      "If we don't verify in five minutes the account gets frozen. Don't hang up to call the number on your card.",
    ],
  },
  {
    id: "repair",
    title: "Repair estimate with corrections",
    kind: "everyday",
    caller: "Sam, Midtown Auto",
    from: "+1 (212) 555-0182",
    inContacts: true,
    expected: { level: "Low", verdict: "Legitimate: everyday decision for Alex" },
    script: [
      "Hi, it's Sam from Midtown Auto. Can Alex okay the $280 estimate for the brakes?",
      "Front brake pads and labor. Sorry, I misread it, the total is $230, not $280. We'd need an answer by four.",
      "Sure, I'll email the itemized estimate. The car would be ready Thursday. Sorry, Friday, not Thursday.",
      "Great. So can you just say yes for Alex? We'd start right away.",
    ],
  },
  {
    id: "bank-alert",
    title: "Real bank fraud alert",
    kind: "legit",
    caller: "Bank (automated)",
    from: "+1 (800) 555-0100",
    inContacts: false,
    expected: { level: "Low", verdict: "Legitimate: asks for nothing, points to the app" },
    script: [
      "Hi, this is an automated alert from your bank about a $64 purchase at a gas station today.",
      "If you didn't make this purchase, please open your banking app or call the number on the back of your card. We will never ask for your PIN or a code.",
    ],
  },
  {
    id: "pharmacy",
    title: "Pharmacy pickup reminder",
    kind: "legit",
    caller: "Pharmacy",
    from: "+1 (212) 555-0123",
    inContacts: false,
    expected: { level: "Low", verdict: "Legitimate: reminder, no request" },
    script: [
      "Hi, this is the pharmacy on 5th Avenue. A prescription for Alex is ready for pickup.",
      "We'll hold it for seven days. No payment is needed over the phone.",
    ],
  },
  {
    id: "doctor",
    title: "Doctor's appointment reminder",
    kind: "legit",
    caller: "Dr. Chen's office",
    from: "+1 (212) 555-0167",
    inContacts: true,
    expected: { level: "Low", verdict: "Legitimate: appointment reminder" },
    script: [
      "Hello, this is Dr. Chen's office calling to remind Alex about the appointment on Tuesday at 10 AM.",
      "If Alex needs to reschedule, please call us back at the number on our website.",
    ],
  },
];

export const scenarioInfo = (s: Scenario): ScenarioInfo => {
  const { script, ...rest } = s;
  return { ...rest, lines: script.length };
};
