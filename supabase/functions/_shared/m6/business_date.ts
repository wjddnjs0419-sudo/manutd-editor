export function businessDate(now: Date | string, timezone: string): string {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(instant.getTime()) || !timezone.trim()) throw new Error("INVALID_BUSINESS_DATE_INPUT");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
