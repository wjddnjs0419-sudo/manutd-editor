#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
/**
 * M9: approved article URLs + subject aliases -> ranked REAL photo candidate JSON.
 * This is a CLI boundary for a Python-capable renderer worker. Never publishes.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net \
 *     scripts/m9_collect_media.ts request.json photo_candidates.json
 *
 * request.json requires:
 * { publisher_article_urls: [...], official_article_urls: [...],
 *   slots: [{ slot:"COVER_NEWS", slide_number:1, subject_aliases:["Michael Carrick"] },
 *           { slot:"BODY_NEWS", slide_number:2, subject_aliases:["Dominic Solanke"] },
 *           { slot:"BODY_NEWS", slide_number:3, subject_aliases:["Michael Carrick"] }],
 *   allowed_image_hosts:["i.guim.co.uk"] }
 *
 * CDN hosts are explicit trusted configuration, not derived from fetched HTML.
 */
import { harvestArticlePhotos, type M9PhotoHarvestJob } from "../supabase/functions/_shared/m9/photo_harvest.ts";
import { isGoogleNewsArticleUrl, safePublisherUrl } from "../supabase/functions/trend-discovery/google_news_resolution.ts";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function validateM9SourceRequest(value: unknown): {
  job: M9PhotoHarvestJob;
  allowed_image_hosts: string[];
  google_news_original_urls: string[];
} {
  if (!object(value) || !Array.isArray(value.publisher_article_urls) ||
      !Array.isArray(value.slots) || !Array.isArray(value.allowed_image_hosts)) {
    throw new Error("M9_SOURCE_REQUEST_INVALID");
  }
  const sourceUrls = value.publisher_article_urls;
  const officialUrls = value.official_article_urls ?? [];
  if (!Array.isArray(officialUrls) || sourceUrls.length < 1 ||
      sourceUrls.length > 5 || officialUrls.length > 5 ||
      ![...sourceUrls, ...officialUrls].every(v => typeof v === "string" && safePublisherUrl(v) !== null &&
        !isVideoHost(new URL(v).hostname) && !isGoogleHost(new URL(v).hostname))) {
    throw new Error("M9_SOURCE_URLS_INVALID");
  }
  const googleOriginals = value.google_news_original_urls ?? [];
  if (!Array.isArray(googleOriginals) || googleOriginals.length > 20 ||
    !googleOriginals.every((url) => typeof url === "string" && isGoogleNewsArticleUrl(url))) {
    throw new Error("M9_SOURCE_PROVENANCE_INVALID");
  }
  const slotsValid = value.slots.length >= 2 && value.slots.length <= 6 &&
      value.slots[0]?.slot === "COVER_NEWS" &&
      value.slots.slice(1).every(s => object(s) && s.slot === "BODY_NEWS") &&
      value.slots.every((s, index) => object(s) && Array.isArray(s.subject_aliases) &&
        s.subject_aliases.length >= 1 && s.subject_aliases.length <= 6 &&
        s.subject_aliases.every((name: unknown) => typeof name === "string" && name.trim().length >= 4) &&
        (s.slide_number === undefined || s.slide_number === index + 1));
  if (!slotsValid) {
    throw new Error("M9_SUBJECT_ALIASES_INVALID");
  }
  const hosts = value.allowed_image_hosts;
  if (hosts.length < 1 || hosts.length > 12 ||
      !hosts.every(x => typeof x === "string" &&
        /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/u.test(x) && !x.includes(".."))) {
    throw new Error("M9_TRUSTED_IMAGE_HOSTS_REQUIRED");
  }
  return {
    job: {
      publisher_article_urls: sourceUrls as string[],
      official_article_urls: officialUrls as string[],
      slots: value.slots as unknown as M9PhotoHarvestJob["slots"],
    },
    allowed_image_hosts: hosts as string[],
    google_news_original_urls: googleOriginals as string[],
  };
}

function isVideoHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  return normalized === "youtu.be" || normalized === "youtube.com" || normalized.endsWith(".youtube.com") ||
    normalized === "youtube-nocookie.com" || normalized.endsWith(".youtube-nocookie.com");
}

function isGoogleHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  return normalized === "google.com" || normalized.endsWith(".google.com") || normalized.startsWith("google.") ||
    normalized === "googleusercontent.com" || normalized.endsWith(".googleusercontent.com");
}

export async function collectM9ForWorker(
  input: unknown,
  opts: { fetch?: typeof fetch; now?: Date } = {},
) {
  const request = validateM9SourceRequest(input);
  const result = await harvestArticlePhotos(request.job, {
    allowedImageHosts: request.allowed_image_hosts,
    fetch: opts.fetch,
    now: opts.now,
    maxSourcePages: 5,
    maxImageProbes: 8,
  });
  return {
    schema_version: "m9-media-v1" as const,
    status: result.status,
    review_only: true as const,
    rights_status: "UNVERIFIED" as const,
    candidate_count: result.candidate_count,
    selections: result.selections,
    source_provenance: {
      publisher_article_urls: request.job.publisher_article_urls,
      google_news_original_urls: request.google_news_original_urls,
      source_type: "creative_briefs.evidence_snapshot.sources",
    },
  };
}

if (import.meta.main) {
  if (Deno.args.length !== 2) throw new Error("Usage: m9_collect_media.ts request.json candidates.json");
  const request = JSON.parse(await Deno.readTextFile(Deno.args[0]));
  const result = await collectM9ForWorker(request);
  await Deno.writeTextFile(Deno.args[1], JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    status: result.status, candidates: result.candidate_count,
    selected_slots: result.selections.filter(s => s.selected !== null).length,
  }));
}
