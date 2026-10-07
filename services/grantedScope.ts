import { REQUIRED_OAUTH_SCOPES } from "@constants/index";
import { authLog } from "./authLog";

export interface AccessTokenClaims {
    iss?: unknown;
    scope?: unknown;
    exp?: unknown;
    sub?: unknown;
    aud?: unknown;
    client_id?: unknown;
    name?: unknown;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const base64UrlToBytes = (input: string): Uint8Array | null => {
    const clean = input.replace(/=+$/, "");
    for (let i = 0; i < clean.length; i++) {
        if (BASE64URL_ALPHABET.indexOf(clean.charAt(i)) === -1) return null;
    }
    if (clean.length % 4 === 1) return null;

    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
        buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(clean.charAt(i));
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(bytes);
};

const utf8Decode = (bytes: Uint8Array): string => {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
        const byte = bytes[i++];
        let codePoint: number;
        if (byte < 0x80) {
            codePoint = byte;
        } else if (byte >= 0xc0 && byte < 0xe0) {
            codePoint = ((byte & 0x1f) << 6) | (bytes[i++] & 0x3f);
        } else if (byte >= 0xe0 && byte < 0xf0) {
            codePoint = ((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        } else {
            codePoint =
                ((byte & 0x07) << 18) |
                ((bytes[i++] & 0x3f) << 12) |
                ((bytes[i++] & 0x3f) << 6) |
                (bytes[i++] & 0x3f);
        }
        if (codePoint > 0xffff) {
            const offset = codePoint - 0x10000;
            out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
        } else {
            out += String.fromCharCode(codePoint);
        }
    }
    return out;
};

export const decodeAccessToken = (token: string): AccessTokenClaims | null => {
    const segments = token.split(".");
    if (segments.length !== 3) return null;

    const payload = base64UrlToBytes(segments[1]);
    if (!payload) return null;

    try {
        const claims = JSON.parse(utf8Decode(payload));
        if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
        return claims as AccessTokenClaims;
    } catch {
        return null;
    }
};

export const grantedScopes = (token: string): string[] => {
    const scope = decodeAccessToken(token)?.scope;
    if (typeof scope === "string") return scope.split(" ").filter(Boolean);
    if (Array.isArray(scope)) return scope.filter((entry): entry is string => typeof entry === "string");
    return [];
};

export const accessTokenExpiry = (token: string): number | undefined => {
    const exp = decodeAccessToken(token)?.exp;
    return typeof exp === "number" && isFinite(exp) ? exp * 1000 : undefined;
};

export type ScopeCheck =
    | { ok: true; granted: string[] }
    | { ok: false; granted: string[]; missing: string[]; reason: "scope" }
    | { ok: false; granted: []; missing: string[]; reason: "undecodable" };

export const checkGrantedScopes = (
    token: string,
    required: readonly string[] = REQUIRED_OAUTH_SCOPES
): ScopeCheck => {
    const claims = decodeAccessToken(token);
    if (!claims) {
        authLog("the access token could not be decoded, so its scopes are unknown", {
            token,
        });
        return { ok: false, granted: [], missing: [...required], reason: "undecodable" };
    }

    const granted = grantedScopes(token);
    const missing = required.filter((needed) => granted.indexOf(needed) === -1);

    if (missing.length > 0) {
        authLog(
            `the authorization server granted [${granted.join(" ")}] and dropped [${missing.join(" ")}] with no error`
        );
        return { ok: false, granted, missing, reason: "scope" };
    }

    return { ok: true, granted };
};

export default checkGrantedScopes;
