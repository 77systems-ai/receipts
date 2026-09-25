import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization for approved payloads. Object keys sort by
 * UTF-16 code units; array order is significant. Unsupported JSON values are
 * rejected instead of silently being dropped or coerced. This is a versioned
 * Receipts encoding, not a claim of RFC 8785 compliance.
 */
export const PAYLOAD_ENCODING = "receipts-json-v1";

export function canonicalSerialize(payload: unknown): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Payload numbers must be finite.");
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError(`Unsupported approved payload value: ${typeof value}.`);
    }
    if (ancestors.has(value)) throw new TypeError("Approved payload cannot contain cycles.");
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Approved payload objects cannot contain symbol keys.");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new TypeError("Approved payload arrays must be plain JSON arrays.");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) throw new TypeError("Sparse payload arrays are unsupported.");
          const descriptor = descriptors[String(index)]!;
          if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new TypeError("Approved payload arrays cannot contain hidden elements or getters.");
          }
        }
        if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
          throw new TypeError("Payload arrays cannot contain additional properties.");
        }
        return `[${value.map((_, index) => encode(descriptors[String(index)]!.value)).join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Approved payload objects must be plain JSON objects.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).sort();
      return `{${keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Approved payload objects cannot contain hidden properties or getters.");
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(payload);
}

/** SHA-256 of the actual canonical UTF-8 payload, not an integrator's token. */
export function digestPayload(payload: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(payload), "utf8").digest("hex")}`;
}

/** Detach/freeze the approved package so a caller cannot change it after hashing. */
export function freezePayload<T>(payload: T): Readonly<T> {
  const snapshot: unknown = JSON.parse(canonicalSerialize(payload));
  function freeze(value: unknown): void {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(snapshot);
  return snapshot as Readonly<T>;
}
