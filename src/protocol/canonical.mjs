// @ts-check

/**
 * Recursively sort object keys alphabetically while preserving primitives, nulls, and arrays.
 * Conforms to deterministic RFC 8785 (JSON Canonicalization Scheme) principles.
 * 
 * @param {any} value
 * @returns {any}
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  
  const sortedKeys = Object.keys(value).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}

/**
 * Returns a canonicalized deterministic JSON string representation of any object or array.
 * 
 * @param {any} value 
 * @returns {string}
 */
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}
