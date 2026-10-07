import { AUTH_ORIGIN } from "./auth";
import { AGENTS_BETA } from "./agents";

export const PICSARTURL = AGENTS_BETA ? "https://api-staging.picsart.io/v1/" : "https://api.picsart.io/v1/";
export const GENAIURL = AGENTS_BETA ? "https://genai-api-staging.picsart.io/v1/" : "https://genai-api.picsart.io/v1/";
export const REMOVEBG = "figma/removebg" as const;
export const GENERATEIMAGE = "figma/text2image" as const;
export const UPSCALE = "figma/upscale" as const;
export const EDITIMAGE = "figma/painting/edit" as const;
export const EDITIMAGE_POLL_PATHS = ["figma/painting/", "painting/"] as const;
export const BALANACE = "balance" as const;
export const HEADERAPI = "X-Picsart-API-Key" as const;
export const HEADER_PLUGIN_NAME_KEY = "X-Picsart-Plugin" as const;
export const HEADER_PLUGIN_NAME_VALUE = "Figma" as const;

export const HEADER_AUTHORIZATION = "Authorization" as const;
export const BEARER_PREFIX = "Bearer " as const;

export const CORS_SAFE_REQUEST_HEADERS = [
  "origin",
  "x-requested-with",
  "accept",
  "content-type",
  "authorization",
  "apikey",
  "x-picsart-api-key",
  "x-picsart-plugin",
  "platform",
  "language-code",
  "deviceid",
  "withoutlanguageheader",
  "withoutdeviceid",
  "sid",
  "x-app-authorization",
  "appname",
  "touchpoint",
  "x-touchpoint",
  "x-touchpoint-referrer",
  "segments",
] as const;

export const EDIT_MODE_ASYNC = "async" as const;

export const RESULT_HOST_ALLOWLIST = [
  "https://cdn.picsart.io",
  "https://aicdn.picsart.com",
  "https://project-files.picsart.com",
  "https://api.picsart.io",
  "https://genai-api.picsart.io",
] as const;

export const CREDENTIAL_HOST_ALLOWLIST = [
  AGENTS_BETA ? "https://api-staging.picsart.io" : "https://api.picsart.io",
  AGENTS_BETA ? "https://genai-api-staging.picsart.io" : "https://genai-api.picsart.io",
  AUTH_ORIGIN,
] as const;

// Links
export const QUERY_PARAMS =
  "?utm_source=figma&utm_medium=app&utm_campaign=plugins" as const;
export const DEVELOPER_GUIDELINES = (`https://picsart.com/developer-guidelines${QUERY_PARAMS}`) as const;
export const PRIVACY_POLICY = (`https://picsart.com/privacy-policy${QUERY_PARAMS}`) as const;
export const TRUST_CENTER = (`https://picsart.io/trust${QUERY_PARAMS}`) as const;
export const HELP_CENTER = (`https://help.picsart.io/hc/en-us${QUERY_PARAMS}`) as const;
export const PRICING = (`https://console.picsart.io/usage${QUERY_PARAMS}`) as const;
export const PICSART_IO = (`https://picsart.io${QUERY_PARAMS}`) as const;
export const CONSOLE = (`https://console.picsart.io${QUERY_PARAMS}`) as const;
export const LEARN_MORE = (`https://docs.picsart.io/docs/creative-apis-get-api-key${QUERY_PARAMS}`) as const;
export const APPS = (`https://console.picsart.io/apps${QUERY_PARAMS}`) as const;
 
