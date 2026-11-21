import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRetryable } from "../src/brain/llm.ts";

describe("isRetryable", () => {
  it("returns true for HTTP 429, 500, and 503 status codes", () => {
    assert.equal(isRetryable({ status: 429 }), true);
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ statusCode: 429 }), true);
    assert.equal(isRetryable({ code: 503 }), true);
    assert.equal(isRetryable({ response: { status: 500 } }), true);
    assert.equal(isRetryable(Object.assign(new Error("Too Many Requests"), { status: 429 })), true);
  });

  it("returns true for transient gRPC/network messages", () => {
    assert.equal(isRetryable(new Error("RESOURCE_EXHAUSTED: quota limit")), true);
    assert.equal(isRetryable(new Error("503 UNAVAILABLE")), true);
    assert.equal(isRetryable(new Error("INTERNAL error from upstream")), true);
    assert.equal(isRetryable(new TypeError("fetch failed")), true);
    assert.equal(isRetryable("HTTP 503 Service Unavailable"), true);
    assert.equal(isRetryable(new Error("request failed", { cause: new TypeError("fetch failed") })), true);
  });

  it("returns false for client errors, aborts, bad JSON, and unrelated errors", () => {
    assert.equal(isRetryable(null), false);
    assert.equal(isRetryable(undefined), false);
    assert.equal(isRetryable(new SyntaxError("Unexpected token } in JSON")), false);
    assert.equal(isRetryable(new DOMException("The operation was aborted", "AbortError")), false);
    assert.equal(isRetryable(new Error("timeout after 5000 ms")), false);
    assert.equal(isRetryable(Object.assign(new Error("INVALID_ARGUMENT"), { status: 400 })), false);
    assert.equal(isRetryable(Object.assign(new Error("PERMISSION_DENIED"), { status: 403 })), false);
    assert.equal(isRetryable(Object.assign(new Error("NOT_FOUND"), { status: 404 })), false);
    // A 400 client error whose message mentions "500" must still not be retried.
    assert.equal(isRetryable(Object.assign(new Error("limit is 500 chars"), { status: 400 })), false);
    assert.equal(isRetryable(new Error("ECONNREFUSED on port 5000")), false);
  });
});
