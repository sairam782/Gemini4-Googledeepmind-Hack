import { createHmac, timingSafeEqual } from "node:crypto";

export type TwilioParams = URLSearchParams | Record<string, string>;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Compute Twilio's X-Twilio-Signature for a POST webhook request:
 * base64(HMAC-SHA1(authToken, fullUrl + sorted POST param name+value pairs)).
 * Sorting uses Unix-style case-sensitive code-unit order, matching Twilio's spec.
 */
export function twilioSignature(authToken: string, fullUrl: string, params: TwilioParams): string {
  const entries: [string, string][] =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  entries.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const payload = fullUrl + entries.map(([k, v]) => k + v).join("");
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

/** Constant-time check of an incoming X-Twilio-Signature header. */
export function verifyTwilioRequest(
  authToken: string,
  signature: string | undefined,
  fullUrl: string,
  params: TwilioParams,
): boolean {
  if (!signature) return false;
  return safeEqual(twilioSignature(authToken, fullUrl, params), signature);
}

/**
 * Bind a Media Stream WebSocket to the verified voice webhook:
 * hex(HMAC-SHA256(authToken, callSid)), passed in TwiML <Parameter name="sig"/>.
 */
export function streamSig(authToken: string, callSid: string): string {
  return createHmac("sha256", authToken).update(callSid, "utf8").digest("hex");
}

/** Constant-time check of customParameters.sig against start.callSid. */
export function verifyStreamSig(
  authToken: string,
  callSid: string | undefined,
  sig: string | undefined,
): boolean {
  if (!callSid || !sig) return false;
  return safeEqual(streamSig(authToken, callSid), sig);
}
