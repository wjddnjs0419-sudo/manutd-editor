import { assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1.0.8";
import {
  classifyDeterministically,
  classifyWithFallback,
  type ClassifierProvider,
} from "../../creative-generation/classifier.ts";
import type { ClassifierConfig } from "../../creative-generation/config.ts";

const config: ClassifierConfig = {
  version: "classifier-v1",
  model: "gpt-5.6-luna",
  reasoning: "low",
  confidence_threshold: 0.75,
  keywords: {
    match: ["official lineup", "goal", "full time", "final score", "라인업", "골", "경기 종료"],
    news: ["ruled out", "injury", "transfer", "contract", "부상", "이적", "계약"],
    analysis: ["tactical", "stats", "form", "comparison", "전술", "통계", "폼", "비교"],
  },
  phase_keywords: {
    PRE_MATCH: ["official lineup", "lineup", "라인업"],
    LIVE: ["goal", "red card", "var", "골", "퇴장"],
    POST_MATCH: ["full time", "final score", "경기 종료"],
  },
};

Deno.test("classifies official lineup as MATCH_CONTENT PRE_MATCH", () => {
  const result = classifyDeterministically("Official lineup vs Arsenal: Bruno starts", config);
  assertEquals(result.status, "DETERMINISTIC");
  assertEquals(result.content_mode, "MATCH_CONTENT");
  assertEquals(result.match_phase, "PRE_MATCH");
});

Deno.test("classifies goal event as MATCH_CONTENT LIVE", () => {
  const result = classifyDeterministically("GOAL Bruno 67'", config);
  assertEquals(result.content_mode, "MATCH_CONTENT");
  assertEquals(result.match_phase, "LIVE");
});

Deno.test("classifies full-time result as MATCH_CONTENT POST_MATCH", () => {
  const result = classifyDeterministically("FULL TIME United 2-1 Arsenal", config);
  assertEquals(result.content_mode, "MATCH_CONTENT");
  assertEquals(result.match_phase, "POST_MATCH");
});

Deno.test("classifies injury and transfer updates as NEWS_UPDATE", () => {
  assertEquals(classifyDeterministically("Mount ruled out for six weeks", config).content_mode, "NEWS_UPDATE");
  assertEquals(classifyDeterministically("United agree a new contract", config).content_mode, "NEWS_UPDATE");
});

Deno.test("classifies tactical and statistical captions as ANALYSIS_CONTEXT", () => {
  assertEquals(classifyDeterministically("Why United struggled tactically", config).content_mode, "ANALYSIS_CONTEXT");
  assertEquals(classifyDeterministically("United form stats compared", config).content_mode, "ANALYSIS_CONTEXT");
});

Deno.test("uses match precedence and marks unknown captions ambiguous", () => {
  const match = classifyDeterministically("Official lineup and tactical comparison", config);
  assertEquals(match.content_mode, "MATCH_CONTENT");
  assertEquals(match.match_phase, "PRE_MATCH");
  const unknown = classifyDeterministically("Big update from Manchester", config);
  assertEquals(unknown.status, "AMBIGUOUS");
  assertEquals(unknown.reason_code, "NO_DETERMINISTIC_SIGNAL");
});

Deno.test("calls AI fallback only for ambiguity", async () => {
  let calls = 0;
  const provider: ClassifierProvider = {
    classify: async () => {
      calls += 1;
      return { content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.9, reason_code: "MODEL_SIGNAL" };
    },
  };
  const known = await classifyWithFallback("Mount injury update", config, provider);
  assertEquals(known.source, "DETERMINISTIC");
  assertEquals(calls, 0);
  const unknown = await classifyWithFallback("Big update from Manchester", config, provider);
  assertEquals(unknown.source, "AI_FALLBACK");
  assertEquals(unknown.content_mode, "NEWS_UPDATE");
  assertEquals(calls, 1);
});

Deno.test("below-threshold fallback becomes CLASSIFICATION_UNCERTAIN", async () => {
  const result = await classifyWithFallback("Big update", config, {
    classify: async () => ({ content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.4, reason_code: "WEAK" }),
  });
  assertEquals(result.source, "UNCERTAIN");
  assertEquals(result.reason_code, "CLASSIFICATION_UNCERTAIN");
});
