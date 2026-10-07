import { OAUTH_RECORD_NAME } from "@constants/index";
import type { CredentialDescriptor } from "@app-types/credential";
import { authLog } from "./authLog";

export interface OAuthRecord {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scopes?: string[];
    clientId?: string;
    writtenAt: number;
}

// Figma can reject persistence (for example for an unregistered development
// manifest). Keep a successful login in this sandbox, never in the UI or logs.
// Reopening the plugin still requires sign-in, as the existing warning explains.
let sessionRecords = new WeakMap<PluginAPI, OAuthRecord>();
let clearedSessions = new WeakSet<PluginAPI>();
export const resetSessionOAuthRecords = () => {
    sessionRecords = new WeakMap();
    clearedSessions = new WeakSet();
};

const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && isFinite(value) ? value : undefined;

const asRecord = (stored: unknown): OAuthRecord | undefined => {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
    const source = stored as Record<string, unknown>;

    const accessToken = asString(source.accessToken);
    if (!accessToken) return undefined;

    const scopes = Array.isArray(source.scopes)
        ? source.scopes.filter((entry): entry is string => typeof entry === "string")
        : undefined;

    return {
        accessToken,
        refreshToken: asString(source.refreshToken),
        expiresAt: asNumber(source.expiresAt) ?? 0,
        scopes,
        clientId: asString(source.clientId),
        writtenAt: asNumber(source.writtenAt) ?? 0,
    };
};

export const readOAuthRecord = async (
    pluginApi: PluginAPI
): Promise<OAuthRecord | undefined> => {
    if (clearedSessions.has(pluginApi)) return undefined;
    const temporary = sessionRecords.get(pluginApi);
    try {
        const record = asRecord(await pluginApi.clientStorage.getAsync(OAUTH_RECORD_NAME));
        if (temporary && (!record || temporary.writtenAt >= record.writtenAt)) return temporary;
        if (record) sessionRecords.delete(pluginApi);
        if (!record) return undefined;
        return record;
    } catch (error) {
        authLog("failed to read the stored OAuth record:", { error: String(error) });
        return temporary;
    }
};

export const writeOAuthRecord = async (
    pluginApi: PluginAPI,
    record: Omit<OAuthRecord, "writtenAt">
): Promise<OAuthRecord | undefined> => {
    const previous = await readOAuthRecord(pluginApi);
    const stored: OAuthRecord = {
        ...record,
        writtenAt: Math.max(Date.now(), (previous?.writtenAt ?? 0) + 1),
    };

    try {
        await pluginApi.clientStorage.setAsync(OAUTH_RECORD_NAME, stored);
        sessionRecords.delete(pluginApi);
        clearedSessions.delete(pluginApi);
        return stored;
    } catch (error) {
        sessionRecords.set(pluginApi, stored);
        clearedSessions.delete(pluginApi);
        authLog("failed to store the OAuth record:", { error: String(error) });
        return undefined;
    }
};

export const clearOAuthRecord = async (pluginApi: PluginAPI): Promise<boolean> => {
    sessionRecords.delete(pluginApi);
    // A failed disk delete must not restore the old account in this session.
    clearedSessions.add(pluginApi);
    try {
        await pluginApi.clientStorage.deleteAsync(OAUTH_RECORD_NAME);
        clearedSessions.delete(pluginApi);
        return true;
    } catch (error) {
        authLog("failed to clear the OAuth record:", { error: String(error) });
        return false;
    }
};

export type InvalidGrantVerdict =
    | { outcome: "rotated"; record: OAuthRecord }
    | { outcome: "revoked" }
    | { outcome: "gone" };

export const classifyInvalidGrant = async (
    pluginApi: PluginAPI,
    seen: OAuthRecord
): Promise<InvalidGrantVerdict> => {
    const current = await readOAuthRecord(pluginApi);
    if (!current) return { outcome: "gone" };
    if (current.writtenAt > seen.writtenAt) return { outcome: "rotated", record: current };
    return { outcome: "revoked" };
};

export const credentialFromRecord = (record: OAuthRecord): CredentialDescriptor => ({
    kind: "oauth",
    token: record.accessToken,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
});

export const isAccessTokenExpired = (record: OAuthRecord, skewMs = 30_000): boolean =>
    record.expiresAt <= Date.now() + skewMs;

export default readOAuthRecord;
