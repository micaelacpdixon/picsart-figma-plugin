import { afterEach, describe, expect, it, vi } from "vitest";
import { OAUTH_RECORD_NAME, API_KEY_NAME } from "../../constants/index";
import {
  classifyInvalidGrant,
  clearOAuthRecord,
  credentialFromRecord,
  isAccessTokenExpired,
  readOAuthRecord,
  resetSessionOAuthRecords,
  writeOAuthRecord,
  type OAuthRecord,
} from "../oauthStorage";
import { makeFigmaStub } from "./figmaStub";

const record = (over: Partial<OAuthRecord> = {}): Omit<OAuthRecord, "writtenAt"> => ({
  accessToken: "access-1",
  refreshToken: "rt:refresh-1",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["openid", "profile", "workflows.execute"],
  clientId: "dcr-x",
  ...over,
});

const silenceLog = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => { vi.restoreAllMocks(); resetSessionOAuthRecords(); });

describe("the two slots are independent (4A')", () => {
  it("does not read the API key when there is no OAuth record", async () => {
    const { api } = makeFigmaStub({ clientStorage: { [API_KEY_NAME]: "an-api-key" } });

    await expect(readOAuthRecord(api)).resolves.toBeUndefined();
  });

  it("does not touch the API key slot when it writes", async () => {
    const { api, clientStorage } = makeFigmaStub({
      clientStorage: { [API_KEY_NAME]: "an-api-key" },
    });

    await writeOAuthRecord(api, record());

    expect(clientStorage.get(API_KEY_NAME)).toBe("an-api-key");
    expect(clientStorage.has(OAUTH_RECORD_NAME)).toBe(true);
  });

  it("does not touch the API key slot when it clears", async () => {
    const { api, clientStorage } = makeFigmaStub({
      clientStorage: { [API_KEY_NAME]: "an-api-key", [OAUTH_RECORD_NAME]: record() },
    });

    await clearOAuthRecord(api);

    expect(clientStorage.get(API_KEY_NAME)).toBe("an-api-key");
    expect(clientStorage.has(OAUTH_RECORD_NAME)).toBe(false);
  });
});

describe("reading a record", () => {
  it("round-trips what was written", async () => {
    const { api } = makeFigmaStub();
    const written = await writeOAuthRecord(api, record());

    await expect(readOAuthRecord(api)).resolves.toEqual(written);
  });

  it("resolves rather than rejecting when the read fails", async () => {
    const log = silenceLog();
    const { api } = makeFigmaStub({ storageFails: { get: true } });

    await expect(readOAuthRecord(api)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it.each([
    ["a string, from an older schema", "just-a-token"],
    ["a number", 42],
    ["an array", ["access-1"]],
    ["a record with no access token", { refreshToken: "rt:x" }],
    ["a record whose access token is empty", { accessToken: "", refreshToken: "rt:x" }],
  ])("discards %s rather than half-using it", async (_label, stored) => {
    const { api } = makeFigmaStub({ clientStorage: { [OAUTH_RECORD_NAME]: stored } });

    await expect(readOAuthRecord(api)).resolves.toBeUndefined();
  });

  it("treats a record with no usable expiry as already expired, not as eternal", async () => {
    const { api } = makeFigmaStub({
      clientStorage: { [OAUTH_RECORD_NAME]: { accessToken: "a", expiresAt: "soon" } },
    });

    const stored = await readOAuthRecord(api);

    expect(stored?.expiresAt).toBe(0);
    expect(isAccessTokenExpired(stored as OAuthRecord)).toBe(true);
  });

  it("drops a corrupt scopes field rather than defaulting it to empty", async () => {
    const { api } = makeFigmaStub({
      clientStorage: { [OAUTH_RECORD_NAME]: { accessToken: "a", expiresAt: 1, scopes: "openid" } },
    });

    const stored = await readOAuthRecord(api);

    expect(stored?.scopes).toBeUndefined();
    expect(credentialFromRecord(stored as OAuthRecord).scopes).toBeUndefined();
  });

  it("keeps only the string entries of a mixed scopes array", async () => {
    const { api } = makeFigmaStub({
      clientStorage: {
        [OAUTH_RECORD_NAME]: { accessToken: "a", expiresAt: 1, scopes: ["openid", 7, null] },
      },
    });

    await expect(readOAuthRecord(api)).resolves.toMatchObject({ scopes: ["openid"] });
  });
});

describe("writing a record", () => {
  it("stamps a writtenAt strictly greater than the one already stored", async () => {
    const { api } = makeFigmaStub();

    const first = await writeOAuthRecord(api, record());
    const second = await writeOAuthRecord(api, record({ accessToken: "access-2" }));

    expect((second as OAuthRecord).writtenAt).toBeGreaterThan((first as OAuthRecord).writtenAt);
  });

  it("stays monotonic when the clock steps backwards", async () => {
    const { api } = makeFigmaStub();
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(10_000);
    const first = await writeOAuthRecord(api, record());
    now.mockReturnValue(1_000);
    const second = await writeOAuthRecord(api, record({ accessToken: "access-2" }));

    expect((first as OAuthRecord).writtenAt).toBe(10_000);
    expect((second as OAuthRecord).writtenAt).toBe(10_001);
  });

  it("reports a failed write instead of returning the record it did not store", async () => {
    const log = silenceLog();
    const { api } = makeFigmaStub({ storageFails: { set: true } });

    await expect(writeOAuthRecord(api, record())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("reports a failed clear rather than claiming the user is signed out", async () => {
    const log = silenceLog();
    const { api } = makeFigmaStub({
      storageFails: { delete: true },
      clientStorage: { [OAUTH_RECORD_NAME]: record() },
    });

    await expect(clearOAuthRecord(api)).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
  });
});

describe("classifyInvalidGrant (2A)", () => {
  it("calls it a rotation when another document has written since", async () => {
    const { api } = makeFigmaStub();
    const seen = (await writeOAuthRecord(api, record())) as OAuthRecord;
    const theirs = (await writeOAuthRecord(api, record({ accessToken: "access-2" }))) as OAuthRecord;

    const verdict = await classifyInvalidGrant(api, seen);

    expect(verdict).toEqual({ outcome: "rotated", record: theirs });
  });

  it("compares writtenAt, not the token — a rotation can reissue the same one", async () => {
    const { api } = makeFigmaStub();
    const seen = (await writeOAuthRecord(api, record())) as OAuthRecord;
    await writeOAuthRecord(api, record());

    await expect(classifyInvalidGrant(api, seen)).resolves.toMatchObject({ outcome: "rotated" });
  });

  it("calls it revoked when storage still holds exactly what we sent", async () => {
    const { api } = makeFigmaStub();
    const seen = (await writeOAuthRecord(api, record())) as OAuthRecord;

    await expect(classifyInvalidGrant(api, seen)).resolves.toEqual({ outcome: "revoked" });
  });

  it("calls it gone when someone signed out underneath us", async () => {
    const { api } = makeFigmaStub();
    const seen = (await writeOAuthRecord(api, record())) as OAuthRecord;
    await clearOAuthRecord(api);

    await expect(classifyInvalidGrant(api, seen)).resolves.toEqual({ outcome: "gone" });
  });
});

describe("credentialFromRecord", () => {
  it("carries the granted scopes, so a 401 can name a missing one", async () => {
    const { api } = makeFigmaStub();
    const stored = (await writeOAuthRecord(api, record())) as OAuthRecord;

    expect(credentialFromRecord(stored)).toEqual({
      kind: "oauth",
      token: "access-1",
      scopes: ["openid", "profile", "workflows.execute"],
      expiresAt: stored.expiresAt,
    });
  });

  it("treats a token inside the clock-skew margin as already expired", () => {
    const nearly: OAuthRecord = { accessToken: "a", expiresAt: Date.now() + 5_000, writtenAt: 1 };

    expect(isAccessTokenExpired(nearly)).toBe(true);
    expect(isAccessTokenExpired({ ...nearly, expiresAt: Date.now() + 600_000 })).toBe(false);
  });
});


describe("temporary OAuth sessions when Figma storage fails", () => {
  it("keeps the new account, not an older persisted account, and accepts a newer external rotation", async () => {
    silenceLog();
    const { api, clientStorage } = makeFigmaStub({ storageFails: { set: true },
      clientStorage: { [OAUTH_RECORD_NAME]: { ...record({ accessToken: "old-account" }), writtenAt: 1 } } });
    await writeOAuthRecord(api, record({ accessToken: "new-account" }));
    const temporary = await readOAuthRecord(api);
    expect(temporary?.accessToken).toBe("new-account");
    clientStorage.set(OAUTH_RECORD_NAME, { ...record({ accessToken: "rotated" }), writtenAt: temporary!.writtenAt + 1 });
    expect((await readOAuthRecord(api))?.accessToken).toBe("rotated");
  });

  it("retains a rotated refresh token in memory even when both reads and writes fail", async () => {
    silenceLog();
    const { api } = makeFigmaStub({ storageFails: { get: true, set: true } });
    await writeOAuthRecord(api, record());
    await writeOAuthRecord(api, record({ accessToken: "access-2", refreshToken: "rt:rotated" }));
    expect(await readOAuthRecord(api)).toMatchObject({ accessToken: "access-2", refreshToken: "rt:rotated" });
    resetSessionOAuthRecords();
    expect(await readOAuthRecord(api)).toBeUndefined();
  });

  it("clears the active account even if deleting the old disk record fails", async () => {
    silenceLog();
    const { api } = makeFigmaStub({ storageFails: { set: true, delete: true },
      clientStorage: { [OAUTH_RECORD_NAME]: { ...record({ accessToken: "old-account" }), writtenAt: 1 } } });
    await writeOAuthRecord(api, record({ accessToken: "new-account" }));
    expect(await clearOAuthRecord(api)).toBe(false);
    expect(await readOAuthRecord(api)).toBeUndefined();
    await writeOAuthRecord(api, record({ accessToken: "fresh-login" }));
    expect((await readOAuthRecord(api))?.accessToken).toBe("fresh-login");
  });
});
