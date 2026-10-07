import { AGENTS_BETA } from "./agents";

export const API_KEY_NAME = AGENTS_BETA ? "picsart_api_key_stage" : "picsart_api_key";

export const OAUTH_RECORD_NAME = AGENTS_BETA ? "picsart_oauth_stage" : "picsart_oauth";

export const WIDGET_WIDTH = 320;

/**
 * Figma's own hard limit on `figma.createImage`, in pixels, in either dimension.
 *
 * Past it Figma throws "Image is too large", which is not something the plugin can
 * work around — it is where a result stops being placeable. It bounds two separate
 * things: how far an upscale factor may go, and how large a source image may be
 * uploaded for editing (edit output tracks the source resolution, so a 6000px source
 * produces a result Figma will not accept).
 */
export const FIGMA_MAX_IMAGE_DIMENSION = 4096;
export const MIN_SOURCE_DIMENSION = 16;
export const WIDGET_HEIGHT_WITH_KEY = 300;
export const WIDGET_HEIGHT_WITHOUT_KEY = 450;

export const WIDGET_HEIGHT_SIGN_IN = 420;

export const WIDGET_HEIGHT_ACCOUNT = 560;
export const WIDGET_HEIGHT_GENERATE_IMAGE = 680;
export const WIDGET_HEIGHT_UPSCALE_WITH_KEY = 380;
export const WIDGET_HEIGHT_UPSCALE_WITHOUT_KEY = 480;

// Heights requested while an advanced-settings panel is open. The window grows
// so the extra controls fit; if the screen cannot accommodate the request,
// Figma clamps it and .scrollable-content scrolls instead.
export const WIDGET_HEIGHT_REMOVE_BG_ADVANCED = 690;
export const WIDGET_HEIGHT_UPSCALE_ADVANCED = 430;
export const WIDGET_HEIGHT_GENERATE_IMAGE_ADVANCED = 830;

export default {
    API_KEY_NAME,
    OAUTH_RECORD_NAME,
    WIDGET_WIDTH,
    FIGMA_MAX_IMAGE_DIMENSION,
    MIN_SOURCE_DIMENSION,
    WIDGET_HEIGHT_WITH_KEY,
    WIDGET_HEIGHT_WITHOUT_KEY,
    WIDGET_HEIGHT_SIGN_IN,
    WIDGET_HEIGHT_ACCOUNT,
    WIDGET_HEIGHT_GENERATE_IMAGE,
    WIDGET_HEIGHT_UPSCALE_WITH_KEY,
    WIDGET_HEIGHT_UPSCALE_WITHOUT_KEY,
    WIDGET_HEIGHT_REMOVE_BG_ADVANCED,
    WIDGET_HEIGHT_UPSCALE_ADVANCED,
    WIDGET_HEIGHT_GENERATE_IMAGE_ADVANCED
}
