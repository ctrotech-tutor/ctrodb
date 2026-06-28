# Issue 2: Validation Plugin Rejects Empty Strings on Non-Required Fields

**Severity:** HIGH
**File(s):** `src/plugins/validation/index.ts`, `src/types.ts`
**Status:** Planned

## Problem

The `noEmptyStrings` built-in rule fires for **every** string value, regardless of whether the field is `required`. If a user has an optional string field (e.g., `description: { type: "string" }`) and passes an empty string `""`, the validation plugin throws.

The rule has no access to the schema's `FieldDefinition` — its signature is `validate(collection, field, value, data)` with no `fieldDef` parameter.

The ordering concern in the audit (`onBeforeCreate` runs before `applyDefaults`) is actually not the core bug — it's that the rule itself doesn't know which fields are required.

## Fix Strategy

### Changes

1. **`src/plugins/validation/index.ts`** — Two changes:
   - Add `fieldDef?: FieldDefinition` parameter to the `ValidationRule.validate` signature.
   - In `validateAll` / `validateRecord`, pass the field definition from the schema to each rule.
   - Modify `noEmptyStrings` to skip non-required fields (check `fieldDef?.required !== true`), so empty strings are allowed on optional fields.

2. **`src/types.ts`** — The `ValidationRule` interface signature changes to include optional `fieldDef`.

### Key considerations

- Backward compatibility: existing custom rules that don't use `fieldDef` still work — it's optional.
- The `email` and `url` built-in rules don't need the schema context — they have their own heuristics.
- Schema access: `ValidationEngine` needs a way to look up `FieldDefinition`. We add a `schema` reference (or a lookup function) to the engine so `validateAll` can fetch field defs by name.

### Verification

- Create optional string field, pass empty string → should NOT throw
- Create required string field, pass empty string → SHOULD throw
- Create optional string field, omit the field → should not throw (defaults apply)
- Custom rules without fieldDef should still work
