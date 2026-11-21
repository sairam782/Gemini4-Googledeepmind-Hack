// Self-check for Twilio webhook and Media Stream HMAC verification.
//   cd server && npx tsx scripts/check-twilio-auth.ts
//
// Worked example from Twilio's official webhook security documentation:
//   https://www.twilio.com/docs/usage/security
//   (also referenced from https://www.twilio.com/docs/usage/webhooks/webhooks-security)
//
//   URL:        https://example.com/myapp.php?foo=1&bar=2
//   AuthToken:  12345
//   POST fields (unsorted in the doc):
//     Digits  = 1234
//     To      = +18005551212
//     From    = +14158675310
//     Caller  = +14158675310
//     CallSid = CA1234567890ABCDE
//   Expected X-Twilio-Signature:
//     L/OH5YylLD5NRKLltdqwSvS0BnU=

import assert from "node:assert/strict";
import { streamSig, twilioSignature, verifyStreamSig, verifyTwilioRequest } from "../src/twilioAuth.ts";

const authToken = "12345";
const url = "https://example.com/myapp.php?foo=1&bar=2";
const params = {
  Digits: "1234",
  To: "+18005551212",
  From: "+14158675310",
  Caller: "+14158675310",
  CallSid: "CA1234567890ABCDE",
};
const expectedSig = "L/OH5YylLD5NRKLltdqwSvS0BnU=";

// 1. Official worked example (object and URLSearchParams, unsorted input).
assert.equal(twilioSignature(authToken, url, params), expectedSig);
assert.equal(verifyTwilioRequest(authToken, expectedSig, url, params), true);

const form = new URLSearchParams(Object.entries(params));
assert.equal(twilioSignature(authToken, url, form), expectedSig);
assert.equal(verifyTwilioRequest(authToken, expectedSig, url, form), true);

// 2. Tampered inputs must all fail.
assert.equal(verifyTwilioRequest(authToken, expectedSig, "http://example.com/myapp.php?foo=1&bar=2", params), false);
assert.equal(verifyTwilioRequest(authToken, expectedSig, "https://example.com/myapp.php?foo=1&bar=3", params), false);
assert.equal(verifyTwilioRequest(authToken, expectedSig, url, { ...params, Digits: "1235" }), false);
assert.equal(verifyTwilioRequest(authToken, expectedSig, url, { ...params, Extra: "1" }), false);
assert.equal(verifyTwilioRequest("wrong-token", expectedSig, url, params), false);
assert.equal(verifyTwilioRequest(authToken, "A" + expectedSig.slice(1), url, params), false);
assert.equal(verifyTwilioRequest(authToken, expectedSig.slice(0, -1), url, params), false);
assert.equal(verifyTwilioRequest(authToken, "", url, params), false);
assert.equal(verifyTwilioRequest(authToken, undefined, url, params), false);

// 3. Media Stream CallSid HMAC-SHA256 signature.
const sig = streamSig(authToken, params.CallSid);
assert.match(sig, /^[0-9a-f]{64}$/);
assert.equal(verifyStreamSig(authToken, params.CallSid, sig), true);
assert.equal(verifyStreamSig(authToken, "CA000000000000000", sig), false);
assert.equal(verifyStreamSig(authToken, params.CallSid, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0")), false);
assert.equal(verifyStreamSig("wrong-token", params.CallSid, sig), false);
assert.equal(verifyStreamSig(authToken, undefined, sig), false);
assert.equal(verifyStreamSig(authToken, params.CallSid, undefined), false);

console.log("check-twilio-auth: all assertions passed");
