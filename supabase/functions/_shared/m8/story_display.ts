const DISPLAY_ALIASES = [
  { phrases: ["sir alex ferguson"], label: "퍼거슨" },
  { phrases: ["pep guardiola"], label: "과르디올라" },
  { phrases: ["manchester united", "man utd", "man united"], label: "맨유" },
  { phrases: ["manchester city"], label: "맨시티" },
  { phrases: ["premier league"], label: "PL" },
  { phrases: ["the guardian"], label: "가디언" },
  { phrases: ["talksport"], label: "토크스포츠" },
] as const;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function internalTokenString(value: string): boolean {
  return value.includes("_") || /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/iu.test(value);
}

function compactInternalTitle(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US");
  const matches = DISPLAY_ALIASES.flatMap((alias) => {
    const positions = alias.phrases.flatMap((phrase) => {
      const position = normalized.indexOf(phrase);
      return position < 0 ? [] : [{ position, label: alias.label }];
    });
    return positions;
  }).sort((left, right) => left.position - right.position);
  const labels = [...new Set(matches.map((match) => match.label))];
  return labels.length > 0 ? `${labels.join(" · ")} 관련 소재` : "맨유 관련 소재";
}

export function displayStoryTitle(raw: string): string {
  const normalized = normalize(raw);
  if (!normalized) return "맨유 관련 소재";
  if (internalTokenString(raw)) return compactInternalTitle(normalized);
  if (normalized.length > 72) return `${normalized.slice(0, 69).trimEnd()}…`;
  return normalized;
}
