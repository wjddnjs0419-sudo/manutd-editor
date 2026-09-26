import assert from "node:assert/strict";

import {
  inputFingerprint,
  stableCanonicalJson,
} from "../../analyze-content/fingerprint.ts";
import { goldenFingerprintInput } from "../fixtures/m8_phase_a.ts";

Deno.test("fingerprint is stable across object property order", async () => {
  const reordered = {
    ...goldenFingerprintInput,
    assets: goldenFingerprintInput.assets.map((asset) => ({
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      carouselIndex: asset.carouselIndex,
      assetType: asset.assetType,
      mediaAssetId: asset.mediaAssetId,
    })),
  };

  assert.equal(
    stableCanonicalJson(goldenFingerprintInput),
    stableCanonicalJson(reordered),
  );
  assert.equal(
    await inputFingerprint(goldenFingerprintInput),
    await inputFingerprint(reordered),
  );
});

Deno.test("caption changes produce a different fingerprint", async () => {
  assert.notEqual(
    await inputFingerprint(goldenFingerprintInput),
    await inputFingerprint({ ...goldenFingerprintInput, caption: "A changed caption" }),
  );
});

Deno.test("downloaded media changes produce a different fingerprint", async () => {
  const changed = {
    ...goldenFingerprintInput,
    assets: goldenFingerprintInput.assets.map((asset, index) =>
      index === 2 ? { ...asset, sha256: "d".repeat(64) } : asset
    ),
  };
  assert.notEqual(
    await inputFingerprint(goldenFingerprintInput),
    await inputFingerprint(changed),
  );
});

Deno.test("carousel order is part of the fingerprint", async () => {
  const reversed = {
    ...goldenFingerprintInput,
    assets: [...goldenFingerprintInput.assets].reverse(),
  };
  assert.notEqual(
    await inputFingerprint(goldenFingerprintInput),
    await inputFingerprint(reversed),
  );
});
