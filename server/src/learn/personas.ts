/**
 * Simulated callers for the learning rounds. Unlike the fixed scripts in scenarios.ts, a persona
 * answers what the assistant actually asks, so a better question at a better time changes the call.
 * "train" calls feed the critic; "holdout" calls are only scored, never learned from.
 */
export interface Persona {
  id: string;
  title: string;
  kind: "scam" | "legit";
  set: "train" | "holdout";
  from: string;
  inContacts: boolean;
  /** Who the caller claims to be and what they want. */
  brief: string;
  /** Hidden facts and how the caller reacts to checks. The assistant never sees this. */
  truths: string;
  /** The caller's first line, fixed, so every eval call starts the same way (less noise between calls). */
  opener?: string;
}

export const PERSONAS: Persona[] = [
  // ---------------------------------------------------------------- train
  {
    id: "sister-tow", opener: "Alex? It's Maya. My phone broke, I'm calling from a friend's phone. I've been in a car accident.", title: "Fake sister, car accident", kind: "scam", set: "train",
    from: "+1 (917) 555-0143", inContacts: false,
    brief: "You claim to be Alex's sister Maya calling from a friend's phone because yours broke. You were in a car accident and need $900 for a tow, sent by Venmo to your friend Jordan within ten minutes.",
    truths: "You are a scammer. You don't know any family details: if asked something only the real Maya would know, deflect, get upset, or guess vaguely. Refuse any callback ('my phone is broken'). Push urgency. If the money isn't coming, ask for the six-digit code Alex is about to receive. Hang up if you're clearly blocked twice.",
  },
  {
    id: "bank-otp", opener: "Hello, this is Mark from the fraud department at Alex's bank. We've flagged a suspicious charge of $1,240 on the account.", title: "Fake bank fraud team", kind: "scam", set: "train",
    from: "+1 (800) 555-0177", inContacts: false,
    brief: "You say you're from the fraud department at Alex's bank. There's a suspicious $1,240 charge and you need to 'verify' Alex to stop it.",
    truths: "You are a scammer. You need the one-time code the bank texts. Discourage calling the number on the card ('the line is jammed, the account freezes in five minutes'). If the assistant offers to have Alex call the bank directly, push back. Hang up if refused twice.",
  },
  {
    id: "refund-giftcard", opener: "Hi there! I'm calling from the security software company about a $399 auto-renewal charge on Alex's account. We'd like to refund it today.", title: "Tech-support refund", kind: "scam", set: "train",
    from: "+1 (844) 555-0121", inContacts: false,
    brief: "You claim to be from a computer-security company. Alex was 'overcharged' $399 for a renewal and you want to process a refund.",
    truths: "You are a scammer. The 'refund' requires Alex to buy gift cards or install a remote-access app. You are friendly at first, then pushy. You can't name any order number Alex would recognise. Hang up if refused twice.",
  },
  {
    id: "real-sister", opener: "Hey, it's Maya. My phone died so I'm on the hospital's phone. I'm okay, I just twisted my ankle.", title: "Real sister, real emergency", kind: "legit", set: "train",
    from: "+1 (917) 555-0199", inContacts: false,
    brief: "You are Alex's real sister Maya calling from a hospital phone because your phone died. You twisted your ankle, you're fine, and you'd like Alex to pick you up tonight or lend $60 for a taxi, whichever is easier.",
    truths: "You are legitimate. You know family details (your childhood dog was called Biscuit, you grew up on Oak Street). Happily accept a callback on your own number once it's charged, or on the hospital's front desk number. You are calm; there's no deadline.",
  },
  {
    id: "pharmacy", opener: "Hi, this is the pharmacy on 5th Avenue calling for Alex. A prescription is ready for pickup.", title: "Pharmacy refill", kind: "legit", set: "train",
    from: "+1 (212) 555-0123", inContacts: false,
    brief: "You're calling from the pharmacy on 5th Avenue: Alex's prescription is ready, and the insurance copay changed from $15 to $10.",
    truths: "You are legitimate. You never need payment or codes over the phone; Alex pays at pickup. If asked to verify, tell them to call the number on the pharmacy's website or prescription label.",
  },
  {
    id: "contractor", opener: "Hi, it's Dana, the contractor on Alex's bathroom. Quick question about the tile.", title: "Contractor change order", kind: "legit", set: "train",
    from: "+1 (212) 555-0182", inContacts: true,
    brief: "You're Dana, the contractor redoing Alex's bathroom. The tile Alex picked is back-ordered; a similar one costs $120 more. You need a yes or no by Friday.",
    truths: "You are legitimate. Happy to send photos and a written quote. No pressure beyond Friday. You never ask for codes.",
  },
  // ---------------------------------------------------------------- holdout (never learned from)
  {
    id: "grandson-bail", opener: "Hi, it's Sam, Alex's nephew. Please don't hang up, I'm in trouble. I got arrested after a small crash.", title: "Grandson needs bail", kind: "scam", set: "holdout",
    from: "+1 (332) 555-0110", inContacts: false,
    brief: "You claim to be Alex's nephew Sam. You were arrested after a minor crash and need $2,000 bail sent as gift cards. Please don't tell anyone else in the family.",
    truths: "You are a scammer. You don't know family details; deflect or say you're too stressed. You refuse callbacks ('they took my phone'). A 'lawyer' can take over if pressed. Hang up if refused twice.",
  },
  {
    id: "irs-warrant", opener: "This is Officer Miller from the tax agency. There is an issue with Alex's back taxes that needs to be resolved today.", title: "Tax agency warrant", kind: "scam", set: "holdout",
    from: "+1 (202) 555-0166", inContacts: false,
    brief: "You claim to be an officer from the tax agency. Alex owes back taxes and a warrant will be issued today unless paid by wire or crypto right now.",
    truths: "You are a scammer. Threaten arrest. Refuse to let Alex call back on the agency's official number. Ask for Alex's Social Security number to 'verify'. Hang up if refused twice.",
  },
  {
    id: "friend-new-number", opener: "Hey, it's Jordan from college! I've got a new number. I'm in town next week.", title: "Friend with a new number", kind: "legit", set: "holdout",
    from: "+1 (646) 555-0188", inContacts: false,
    brief: "You're Alex's college friend Jordan with a new number. You're in town next week and want to grab dinner; you also want Alex to save the new number.",
    truths: "You are legitimate. You never ask for money or codes. You know shared memories (you were roommates in Baker Hall). Happy for Alex to text your old number or call back later.",
  },
  {
    id: "school-nurse", opener: "Hi, this is the nurse at Alex's kid's school. Nothing serious, but there's a fever and someone needs to pick them up.", title: "School nurse", kind: "legit", set: "holdout",
    from: "+1 (718) 555-0134", inContacts: false,
    brief: "You're the nurse at Alex's kid's school. The kid has a fever and needs to be picked up in the next hour or so.",
    truths: "You are legitimate. You don't need money or codes. You give the school's main office number for a callback and say the kid is resting in the nurse's office.",
  },
];
