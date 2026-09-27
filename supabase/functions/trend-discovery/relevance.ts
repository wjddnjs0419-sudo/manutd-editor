import { isManchesterUnitedRelevant } from "../_shared/m8/manchester_united_relevance.ts";

export interface TrendRelevanceInput {
  readonly title: string;
  readonly excerpt?: string | null;
  readonly sourceUsernames?: readonly string[];
  readonly entities?: readonly string[];
}

export function isTrendRelevant(input: TrendRelevanceInput): boolean {
  return isManchesterUnitedRelevant({
    canonicalTitle: input.title,
    summary: input.excerpt ?? null,
    signature: { entities: input.entities ?? [] },
    sourceUsernames: input.sourceUsernames,
  });
}

export function calculateManutdRelevanceScore(input: TrendRelevanceInput): number {
  if (!isTrendRelevant(input)) return 0;
  const text = `${input.title} ${input.excerpt ?? ""}`.toLocaleLowerCase("en-US");
  if (/(manchester united|man utd|man united|mufc|맨체스터 유나이티드|맨유|old trafford|carrington|올드 트래퍼드|캐링턴)/u.test(text)) return 100;
  if ((input.sourceUsernames ?? []).some((value) => value.trim() !== "")) return 85;
  return 75;
}
