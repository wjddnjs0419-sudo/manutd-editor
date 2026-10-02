export type EditorialTrustState = "VERIFIED" | "REPORTED" | "DISCOVERY";

export interface TrustEvidence {
  readonly editorial_role?: string | null;
  readonly canonical_url?: string | null;
}

export interface TrustStory {
  readonly grounding_status?: string | null;
  readonly news_eligible?: boolean;
  readonly evidence?: readonly TrustEvidence[];
  readonly source_url?: string | null;
}

export function editorialTrustState(story: TrustStory): EditorialTrustState {
  if (story.grounding_status === "VERIFIED" && story.news_eligible === true) return "VERIFIED";
  if (!story.grounding_status && story.news_eligible === true) return "VERIFIED";
  const linkedCredibleSource = story.evidence?.some((item) =>
    (item.editorial_role === "FACT_PRIMARY" || item.editorial_role === "FACT_INDEPENDENT") &&
    typeof item.canonical_url === "string" && item.canonical_url.trim() !== ""
  ) ?? false;
  const hasLinkedSource = linkedCredibleSource || (typeof story.source_url === "string" && story.source_url.trim() !== "");
  if (hasLinkedSource && story.grounding_status !== "DISCOVERY_ONLY") return "REPORTED";
  if (story.grounding_status === "DISCOVERY_ONLY" || story.evidence?.some((item) => item.editorial_role?.startsWith("DISCOVERY_") === true)) return "DISCOVERY";
  return "DISCOVERY";
}

export function editorialTrustLabel(state: EditorialTrustState): string {
  return state === "VERIFIED" ? "🟢 확인됨" : state === "REPORTED" ? "🟡 보도됨" : "🔴 미확인";
}

export function editorialTrustInstruction(state: EditorialTrustState): string {
  if (state === "REPORTED") return "Attribute every reported claim with wording such as 보도에 따르면 or ~라는 보도가 나왔다. Never state it as established fact.";
  if (state === "DISCOVERY") return "Explicitly label all claims as unconfirmed/rumor (미확인/이적설/주장). Attribute them to the supplied discovery source. Never present them as fact.";
  return "Use factual language only for claims supported by the supplied verified evidence.";
}
