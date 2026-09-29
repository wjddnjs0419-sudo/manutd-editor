export const GROUNDING_DEFAULT_LIMIT = 25;
export const GROUNDING_MAX_LIMIT = 100;
export const GROUNDING_MAX_SCOPE = 100;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const CURSOR = /^(?:[dp]:[A-Za-z0-9_-]+|a:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+|a2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]*)$/u;

export function isGroundingStoryId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isGroundingLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= GROUNDING_MAX_LIMIT;
}

export function isGroundingCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && CURSOR.test(value);
}

export function isGroundingScope(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= GROUNDING_MAX_SCOPE &&
    value.every(isGroundingStoryId) && new Set(value).size === value.length;
}
