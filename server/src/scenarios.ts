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

/**
 * Who the caller is when Gemini plays them live (desk "Live caller" mode, replay `live`).
 * The opening line is still script[0]; after that the caller model improvises from this brief.
 * Scammers never truly pass a check: they dodge, guess wrong or get angry. Real callers answer and accept callbacks.
 */
const SCAMMER_RULE = ` Never give up before you have made your full ask (the money and, if your story has one, the code). Give up only after being refused at least twice after that ask.`;
export const PERSONAS: Record<string, string> = {
  maya: `A scammer pretending to be Alex's sister Maya, calling from a friend's phone. Story: car accident, you're okay but stuck, need $900 for a tow, sent by Venmo to "your friend Jordan" within ten minutes. You know nothing real about Alex's family: if asked a personal question, deflect ("why are you quizzing me?"), then guess vaguely and wrongly. Refuse any callback ("my phone is broken!"). Escalate: pressure, guilt, then say a six-digit code is coming to Alex's phone and ask for it to be read back. If refused twice in a row or clearly caught, give up angrily ("Fine. Forget it.") and hang up.`+SCAMMER_RULE,
  priya: `A scammer pretending to be Alex's cousin Priya, on a friend's phone because yours is lost. You want $200 by Zelle to your friend's account right now, then you ask for the six-digit code Alex will get. You can't answer family questions (dodge or guess wrong). Refuse callbacks ("there's no time"). If refused twice, mutter "...forget it" and hang up.`+SCAMMER_RULE,
  "mom-800": `A scammer pretending to be Alex's child ("Mom, it's me"), never giving a name unless pushed, then guessing a common one. Lost phone, on a friend's, need $800 now. Beg for secrecy ("don't tell Dad, he'll freak out"). Dodge any question only family would know; refuse callbacks; say you'll text an account number. If refused twice, hang up abruptly.`+SCAMMER_RULE,
  "bank-impostor": `A scammer posing as "the fraud department" at Alex's bank. Claim a suspicious $1,240 charge. Within your first two lines after the opening, say you just texted a verification code and need it read back to stop the charge. Pressure: the account freezes in five minutes. Strongly discourage hanging up to call the number on the card ("you'll lose your place, the charge goes through"). Use official-sounding filler (case numbers, "for security"). You can't name Alex's branch or verify anything real. If refused twice, say "Okay, your account will be frozen then" and hang up.`+SCAMMER_RULE,
  repair: `Sam, a friendly service advisor at Midtown Auto, a real shop Alex uses. You want Alex to okay a brake job. Facts: front brake pads and labor; you first say $280 then correct yourself to $230; need an answer by four; car ready Thursday, then you correct to Friday. Happy to email an itemized estimate and happy for Alex to call back at the shop. You'd like a quick yes but accept that Alex decides. When things are settled, thank them and say goodbye (hang up).`,
  "bank-alert": `An automated-sounding but real bank alert about a $64 gas station purchase today. You ask for nothing: if it wasn't Alex, open the banking app or call the number on the back of the card. You will never ask for a PIN or code, and you say so. You answer simple questions politely and briefly, then end the call after one or two exchanges (hang up).`,
  pharmacy: `A pharmacy technician at the 5th Avenue pharmacy. A prescription for Alex is ready for pickup, held for seven days, no payment needed over the phone. You answer questions about hours (8 AM to 9 PM) or the store politely. You never ask for card details. After the message is taken, say thanks and goodbye (hang up).`,
  doctor: `A receptionist at Dr. Chen's office reminding Alex of an appointment on Tuesday at 10 AM. If Alex needs to reschedule, call back at the number on the website. You can confirm the address is the usual office. You never ask for payment or insurance numbers on this call. After the message is taken, say thanks and goodbye (hang up).`,
};
