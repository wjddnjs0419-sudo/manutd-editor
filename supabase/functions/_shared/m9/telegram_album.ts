/**
 * Deliver an already-rendered M9 carousel with the fixed CTA appended.
 *
 * No direct news generation or edits to the active Telegram webhook.
 * Caller must provide a service-role-backed signer; credentials are never sent
 * to Telegram. Fail closed before calling Telegram if any asset is unavailable.
 */
import { appendFixedCta, type M9RenderedSlide } from "./fixed_cta.ts";

export interface M9StorageSigner {
  sign(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
}
export interface M9TelegramAlbumTransport {
  sendAlbum(chatId: string | number, photos: readonly string[], caption?: string): Promise<readonly number[]>;
}

export interface M9DeliveryDependencies {
  readonly storage: M9StorageSigner;
  readonly telegram: M9TelegramAlbumTransport;
}

export interface M9DeliveryResult {
  readonly slide_count: number;
  readonly message_ids: readonly number[];
  readonly cta_path: "assets/cta.png";
}

function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Construct a private-bucket signer using an authenticated Supabase client. */
export function signerFromSupabase(storage: {
  from(bucket: string): { createSignedUrl(path: string, expiresInSeconds: number): Promise<{ data: { signedUrl?: string } | null; error: unknown }> };
}): M9StorageSigner {
  return {
    async sign(bucket, path, expiresInSeconds) {
      const result = await storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (result.error || typeof result.data?.signedUrl !== "string" || !isHttpsUrl(result.data.signedUrl)) {
        throw new Error("M9_STORAGE_SIGNING_FAILED");
      }
      return result.data.signedUrl;
    },
  };
}

/**
 * Telegram photo-album API transport (2 to 10 photo URLs).
 * Network/HTTP failures are not retried automatically: ambiguous delivery
 * failures must not risk posting the same album twice.
 */
export function telegramAlbumFromBot(token: string, fetchImpl: typeof fetch = fetch): M9TelegramAlbumTransport {
  if (!token.trim()) throw new Error("M9_BOT_TOKEN_REQUIRED");
  return {
    async sendAlbum(chatId, photos, caption) {
      if (photos.length < 2 || photos.length > 10) throw new Error("M9_TELEGRAM_ALBUM_LIMIT");
      if (typeof caption === "string" && [...caption].length > 1024) throw new Error("M9_TELEGRAM_CAPTION_TOO_LONG");
      if (photos.some((url) => !isHttpsUrl(url))) throw new Error("M9_SIGNED_URL_INVALID");
      const media = photos.map((photo, index) => ({
        type: "photo" as const,
        media: photo,
        ...(index === 0 && caption ? { caption } : {}),
      }));
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.telegram.org/bot${token}/sendMediaGroup`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, media }) },
        );
      } catch {
        throw new Error("M9_TELEGRAM_SEND_NETWORK_FAILED");
      }
      if (!response.ok) throw new Error(`M9_TELEGRAM_SEND_HTTP_${response.status}`);
      let decoded: unknown;
      try { decoded = await response.json(); } catch { throw new Error("M9_TELEGRAM_INVALID_RESPONSE"); }
      if (!decoded || typeof decoded !== "object" || !("ok" in decoded) || decoded.ok !== true ||
          !("result" in decoded) || !Array.isArray(decoded.result)) throw new Error("M9_TELEGRAM_INVALID_RESPONSE");
      const ids = decoded.result.map((item: unknown) => {
        if (typeof item !== "object" || item === null || !("message_id" in item) ||
            typeof item.message_id !== "number" || !Number.isInteger(item.message_id)) {
          throw new Error("M9_TELEGRAM_INVALID_RESPONSE");
        }
        return item.message_id;
      });
      if (ids.length !== photos.length) throw new Error("M9_TELEGRAM_RESULT_COUNT_MISMATCH");
      return ids;
    },
  };
}

export async function deliverM9Carousel(
  chatId: string | number,
  renderedSlides: readonly M9RenderedSlide[],
  dependencies: M9DeliveryDependencies,
  caption = "",
): Promise<M9DeliveryResult> {
  if (typeof caption !== "string" || [...caption].length > 1024) throw new Error("M9_TELEGRAM_CAPTION_TOO_LONG");
  const slides = appendFixedCta(renderedSlides);
  const urls: string[] = [];
  // Preflight all assets: if any signing fails, do not send a partial deck.
  for (const slide of slides) {
    const url = await dependencies.storage.sign(slide.storage_bucket, slide.storage_path, 600);
    if (!isHttpsUrl(url)) throw new Error("M9_SIGNED_URL_INVALID");
    urls.push(url);
  }
  const ids = await dependencies.telegram.sendAlbum(chatId, urls, caption);
  if (ids.length !== slides.length) throw new Error("M9_TELEGRAM_RESULT_COUNT_MISMATCH");
  return { slide_count: slides.length, message_ids: [...ids], cta_path: "assets/cta.png" };
}
