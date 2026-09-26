import type {
  ContentUnderstandingOutput,
  FingerprintInput,
} from "../../analyze-content/types.ts";

export const goldenFingerprintInput: FingerprintInput = {
  rawPostId: "00000000-0000-4000-8000-000000000101",
  caption: "Thoughts? 👀",
  mediaType: "CAROUSEL_ALBUM",
  mediaProductType: null,
  analysisVersion: "m8-a-v1",
  model: "test-model",
  promptVersion: "prompt-v1",
  assets: [
    {
      mediaAssetId: "asset-1",
      assetType: "CAROUSEL_CHILD",
      carouselIndex: 0,
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
    },
    {
      mediaAssetId: "asset-2",
      assetType: "CAROUSEL_CHILD",
      carouselIndex: 1,
      mimeType: "image/jpeg",
      sha256: "b".repeat(64),
    },
    {
      mediaAssetId: "asset-3",
      assetType: "CAROUSEL_CHILD",
      carouselIndex: 2,
      mimeType: "image/jpeg",
      sha256: "c".repeat(64),
    },
  ],
};

export const goldenAnalysisOutput: ContentUnderstandingOutput = {
  captionSummary: "A post asks for reactions without explaining the story.",
  visualSummary: "A former Manchester United player is shown training away from a club environment.",
  combinedSummary: "Jadon Sancho is shown in an unexpected training situation after three months without a club.",
  entities: ["Jadon Sancho", "Manchester United", "Flixton FC"],
  topics: ["clubless period", "training situation"],
  onImageText: [
    { text: "Jadon Sancho", slideIndex: 0, confidence: 0.98 },
    { text: "3 months without a club", slideIndex: 2, confidence: 0.96 },
  ],
  importantNumbers: ["3 months", "10th-tier"],
  sourceNames: [],
  claims: [
    {
      subject: "Jadon Sancho",
      predicate: "without_a_club_for",
      object: "3 months",
      text: "The post claims Jadon Sancho has been without a club for three months.",
      origin: "carousel_slide",
      confidence: 0.94,
      evidence: [{ slideIndex: 2, mediaAssetId: "asset-3" }],
    },
    {
      subject: "Jadon Sancho",
      predicate: "training_at",
      object: "Flixton FC facilities",
      text: "The post claims Sancho is training at Flixton FC facilities.",
      origin: "carousel_slide",
      confidence: 0.91,
      evidence: [{ slideIndex: 2, mediaAssetId: null }],
    },
  ],
  contentType: "PLAYER_STATUS",
  visualFormat: "CAROUSEL",
  analysisConfidence: 0.93,
  evidenceState: {
    captionSummary: "OBSERVED",
    visualSummary: "OBSERVED",
    combinedSummary: "INFERRED",
    entities: "OBSERVED",
    topics: "INFERRED",
    onImageText: "OBSERVED",
    claims: "OBSERVED",
  },
};
