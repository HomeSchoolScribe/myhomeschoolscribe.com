// schema-check.js
//
// A small JSON Schema 2020-12 interpreter for the subset hssweek.schema.json uses, so the
// Course Builder page can validate a week without a third-party library (spec section 3,
// "Schema (source of truth)"). Keywords understood: type (one name or a list), const, enum,
// required, properties, items, minItems, maxItems, minimum, maximum, exclusiveMinimum,
// exclusiveMaximum, multipleOf, minLength, maxLength, pattern, oneOf, and $ref to "#/$defs/...".
// Any other keyword is ignored, the way the importer ignores fields it does not know.
//
// No DOM, no network, no globals.

const patternCache = new Map();

function compiledPattern(pattern) {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    patternCache.set(pattern, re);
  }
  return re;
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeName(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`schema-check only follows local references, not ${ref}`);
  }
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => (node == null ? undefined : node[key.replace(/~1/g, "/").replace(/~0/g, "~")]), root);
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : String(key);
}

function show(value) {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function checkString(schema, value, fail) {
  const length = Array.from(value).length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    fail("minLength", schema.minLength === 1 ? "should not be empty" : `should be at least ${schema.minLength} characters`);
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    fail("maxLength", `should be at most ${schema.maxLength.toLocaleString("en-US")} characters`);
  }
  if (schema.pattern !== undefined && !compiledPattern(schema.pattern).test(value)) {
    fail("pattern", `${show(value)} is not in the expected form`);
  }
}

function checkNumber(schema, value, fail) {
  if (schema.minimum !== undefined && value < schema.minimum) fail("minimum", `should be at least ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) fail("maximum", `should be at most ${schema.maximum}`);
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    fail("exclusiveMinimum", `should be more than ${schema.exclusiveMinimum}`);
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    fail("exclusiveMaximum", `should be less than ${schema.exclusiveMaximum}`);
  }
  if (schema.multipleOf !== undefined) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) fail("multipleOf", `should be a multiple of ${schema.multipleOf}`);
  }
}

function checkArray(schema, value, path, root, errors, fail) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    fail("minItems", schema.minItems === 1 ? "should have at least one item" : `should have at least ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    fail("maxItems", `should have at most ${schema.maxItems} items`);
  }
  if (schema.items !== undefined) {
    value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, root, errors));
  }
}

function checkObject(schema, value, path, root, errors) {
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push({ path: joinPath(path, key), message: "is required", keyword: "required" });
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (key in value) check(sub, value[key], joinPath(path, key), root, errors);
  }
}

function checkOneOf(schema, value, path, root, errors, fail) {
  const branches = schema.oneOf.map((sub) => {
    const branchErrors = [];
    check(sub, value, path, root, branchErrors);
    return branchErrors;
  });
  const matching = branches.filter((branchErrors) => branchErrors.length === 0).length;
  if (matching === 1) return;
  if (matching === 0) {
    // When the value has the right type for exactly one branch, that branch's own complaint
    // ("should be at least 5") is more useful than "matches no shape".
    const sameType = branches.filter((branchErrors) => !branchErrors.some((e) => e.keyword === "type"));
    if (sameType.length === 1) {
      errors.push(...sameType[0]);
      return;
    }
  }
  fail("oneOf", matching === 0 ? "does not match any allowed form" : "matches more than one allowed form");
}

function check(schema, value, path, root, errors) {
  if (schema === true || schema == null) return;
  const fail = (keyword, message) => errors.push({ path, message, keyword });

  if (schema.$ref !== undefined) {
    const target = resolveRef(schema.$ref, root);
    if (target === undefined) {
      fail("$ref", `unknown reference ${schema.$ref}`);
      return;
    }
    check(target, value, path, root, errors);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      fail("type", `should be ${types.join(" or ")}, not ${typeName(value)}`);
      return;
    }
  }

  if ("const" in schema && !deepEqual(value, schema.const)) fail("const", `should be ${show(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    fail("enum", `${show(value)} is not one of ${schema.enum.map(show).join(", ")}`);
  }

  if (typeof value === "string") checkString(schema, value, fail);
  if (typeof value === "number") checkNumber(schema, value, fail);
  if (Array.isArray(value)) checkArray(schema, value, path, root, errors, fail);
  else if (value !== null && typeof value === "object") checkObject(schema, value, path, root, errors);

  if (Array.isArray(schema.oneOf)) checkOneOf(schema, value, path, root, errors, fail);
}

/**
 * Validates `value` against `schema` and returns every problem found, as
 * `[{ path, message, keyword }]`. `path` is dotted with array indexes in brackets
 * (`courses[0].lessons[2].minutes`; the root is ""). `keyword` names the failing rule so a
 * caller can treat some (an unknown enum value, say) more gently than others. An empty array
 * means the value is valid.
 */
export function validateSchema(schema, value) {
  const errors = [];
  check(schema, value, "", schema, errors);
  return errors;
}

export { deepEqual };
