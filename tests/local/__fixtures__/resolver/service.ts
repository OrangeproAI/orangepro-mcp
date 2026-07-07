// A source (non-test) file with an internal source->source import, so the
// source_to_source axis has a real datum.
import { saveUser } from "./impl.js";

export function persist(input: string): string {
  return saveUser(input);
}
