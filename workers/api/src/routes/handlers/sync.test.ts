import { describe, expect, it } from "vitest";
import { computeChannelStatus } from "./sync";

describe("computeChannelStatus", () => {
  it("returns revoked when account status is revoked", () => {
    expect(
      computeChannelStatus({
        provider: "google",
        status: "revoked",
        channel_expiry_ts: null,
      }),
    ).toBe("revoked");
  });

  it("returns error when account status is error", () => {
    expect(
      computeChannelStatus({
        provider: "microsoft",
        status: "error",
        channel_expiry_ts: null,
      }),
    ).toBe("error");
  });

  it("returns active for non-google active accounts", () => {
    expect(
      computeChannelStatus({
        provider: "microsoft",
        status: "active",
        channel_expiry_ts: null,
      }),
    ).toBe("active");
  });

  it("returns missing for active google account without expiry", () => {
    expect(
      computeChannelStatus({
        provider: "google",
        status: "active",
        channel_expiry_ts: null,
      }),
    ).toBe("missing");
  });
});
