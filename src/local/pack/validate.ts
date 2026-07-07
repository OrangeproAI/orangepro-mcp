import { ZodIssue } from "zod";
import { evidencePackSchema } from "./schema.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate an unknown object against the strict evidence-pack schema. */
export function validatePack(obj: unknown): ValidationResult {
  const result = evidencePackSchema.safeParse(obj);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: result.error.issues.map(formatIssue) };
}

/** Parse JSON text then validate; reports a JSON error rather than throwing. */
export function validatePackJson(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    return { valid: false, errors: [`<root>: invalid JSON (${message})`] };
  }
  return validatePack(parsed);
}

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}
