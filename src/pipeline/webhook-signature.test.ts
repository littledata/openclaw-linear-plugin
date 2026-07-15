import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { resolveWebhookSigningSecrets, verifyLinearWebhookSignature } from "./webhook.js";

function reqWithSig(sig?: string): IncomingMessage {
  return { headers: sig === undefined ? {} : { "linear-signature": sig } } as unknown as IncomingMessage;
}

function sign(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

describe("Linear webhook signature verification", () => {
  const raw = JSON.stringify({ type: "AgentSessionEvent", action: "created" });
  const secret = "lin_wh_testsecret";

  const savedEnv = process.env.LINEAR_WEBHOOK_SIGNING_SECRET;
  beforeEach(() => { delete process.env.LINEAR_WEBHOOK_SIGNING_SECRET; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WEBHOOK_SIGNING_SECRET;
    else process.env.LINEAR_WEBHOOK_SIGNING_SECRET = savedEnv;
  });

  it("returns 'unconfigured' when no secret is set (back-compat, endpoint open)", () => {
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, secret)), raw, {})).toBe("unconfigured");
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, secret)), raw, undefined)).toBe("unconfigured");
  });

  it("accepts a correct signature (config secret)", () => {
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, secret)), raw, { webhookSigningSecret: secret })).toBe("ok");
  });

  it("accepts a correct signature (env secret)", () => {
    process.env.LINEAR_WEBHOOK_SIGNING_SECRET = secret;
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, secret)), raw, {})).toBe("ok");
  });

  it("rejects a wrong signature", () => {
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, "other-secret")), raw, { webhookSigningSecret: secret })).toBe("invalid");
  });

  it("rejects a tampered body under a valid-looking signature", () => {
    const sig = sign(raw, secret);
    expect(verifyLinearWebhookSignature(reqWithSig(sig), raw + "x", { webhookSigningSecret: secret })).toBe("invalid");
  });

  it("rejects a missing signature header when a secret is configured", () => {
    expect(verifyLinearWebhookSignature(reqWithSig(undefined), raw, { webhookSigningSecret: secret })).toBe("invalid");
  });

  it("supports comma-separated secrets for rotation (any match passes)", () => {
    const cfg = { webhookSigningSecret: "old-secret, " + secret };
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, secret)), raw, cfg)).toBe("ok");
    expect(verifyLinearWebhookSignature(reqWithSig(sign(raw, "old-secret")), raw, cfg)).toBe("ok");
    expect(resolveWebhookSigningSecrets(cfg)).toEqual(["old-secret", secret]);
  });
});
