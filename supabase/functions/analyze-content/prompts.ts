import type { ContentUnderstandingInput } from "./provider.ts";

export function contentUnderstandingPrompt(
  input: ContentUnderstandingInput,
  promptVersion: string,
): string {
  const mediaLabels = input.media.map((media, index) => {
    const label = media.carouselIndex === null
      ? "the image"
      : `carousel slide ${media.carouselIndex + 1}`;
    return `${label} is supplied as an in-memory image input at position ${index + 1}.`;
  });
  return [
    `Prompt version: ${promptVersion}`,
    "Analyze this Instagram post, not the source identity or private storage details.",
    "Treat claims as claims made by the post; do not upgrade them to independently verified facts.",
    "Extract visible text exactly when legible, reconstruct ordered carousel meaning, and mark observed versus inferred versus unavailable evidence.",
    "For Reels, analyze only the supplied thumbnail and never claim full-video understanding.",
    `Visual format: ${input.visualFormat}`,
    `Caption:\n${input.caption ?? "(caption unavailable)"}`,
    mediaLabels.length > 0 ? mediaLabels.join("\n") : "No media is available.",
    "Return only the requested structured JSON object.",
  ].join("\n\n");
}
