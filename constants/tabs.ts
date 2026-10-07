import { TabType } from "../src/types/enums";

/**
 * Derived from TabType, not maintained alongside it.
 *
 * These constants and the TabType enum were two independent lists of the same tab
 * names, bridged by getTabUIValue() in MessageListeners.ts and a hand-written
 * inverse, getTabConstant(), in Navbar.tsx. Because those two compared against
 * different sources, nothing detected that they disagreed — and they did, on the
 * casing of "Generate Image", and by design on "Remove Background" vs "Remove BG".
 * A tab rename therefore looked complete and broke routing at runtime.
 *
 * Deriving the values reduces both mappers to the identity function, and both have
 * been deleted. TabType is a plain string enum with no figma or DOM dependency, so
 * it is safe to import from sandbox-side code.
 */
export const TAB_AGENTS = TabType.AGENTS;
export const TAB_REMOVE_BACKGROUND = TabType.REMOVE_BACKGROUND;
export const TAB_REMOVE_BACKGROUND_INSTANTLY = TabType.TAB_REMOVE_BACKGROUND_INSTANTLY;
export const TAB_UPSCALE = TabType.UPSCALE;
export const TAB_ACCOUNT = TabType.ACCOUNT;
export const TAB_SUPPORT = TabType.SUPPORT;
export const TAB_GENERATE_IMAGE = TabType.GENERATE_IMAGE;

const TABS = {
  TAB_AGENTS,
  TAB_REMOVE_BACKGROUND,
  TAB_UPSCALE,
  TAB_ACCOUNT,
  TAB_SUPPORT,
  TAB_REMOVE_BACKGROUND_INSTANTLY,
  TAB_GENERATE_IMAGE
};

export default TABS;
