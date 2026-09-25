import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalSerialize, digestPayload, freezePayload } from "../src/digest.js";

test("canonical SHA-256 ignores object insertion order but preserves payload changes", () => {
  const left = { body: "Hello", recipients: ["person@example.test"], metadata: { z: 1, a: true } };
  const right = { metadata: { a: true, z: 1 }, recipients: ["person@example.test"], body: "Hello" };
  assert.equal(canonicalSerialize(left), '{"body":"Hello","metadata":{"a":true,"z":1},"recipients":["person@example.test"]}');
  assert.equal(digestPayload(left), digestPayload(right));
  assert.equal(digestPayload(left), `sha256:${createHash("sha256").update(canonicalSerialize(left)).digest("hex")}`);
  assert.notEqual(digestPayload(left), digestPayload({ ...left, body: "Changed" }));
  assert.notEqual(digestPayload([1, 2]), digestPayload([2, 1]));
});

test("ambiguous non-JSON inputs cannot silently collapse to the same digest", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const payload of [undefined, { hidden: undefined }, NaN, Infinity, 1n, new Date(), new Map(), [, 1], cyclic]) {
    assert.throws(() => digestPayload(payload), TypeError);
  }
  assert.throws(() => digestPayload({ get unsafe() { throw new Error("Getter ran"); } }), /getters/);
  assert.throws(() => digestPayload({ [Symbol("hidden")]: true }), /symbol/);
  const arrayGetter = [1];
  Object.defineProperty(arrayGetter, "0", { get() { throw new Error("Getter ran"); }, enumerable: true });
  assert.throws(() => digestPayload(arrayGetter), /getters/);
  const arrayHidden = [1];
  Object.defineProperty(arrayHidden, "extra", { value: "secret", enumerable: false });
  assert.throws(() => digestPayload(arrayHidden), /additional/);
});

test("executor receives a detached, recursively frozen approved payload", () => {
  const approved = { body: { text: "Approved" }, tags: ["one"] };
  const snapshot = freezePayload(approved);
  approved.body.text = "Later edit";
  approved.tags.push("two");
  assert.equal(snapshot.body.text, "Approved");
  assert.deepEqual(snapshot.tags, ["one"]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.body));
  assert.ok(Object.isFrozen(snapshot.tags));
});
