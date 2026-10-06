export enum TabType {
  AGENTS = "AI Agents",
  TAB_REMOVE_BACKGROUND_INSTANTLY = "Remove Background Instantly",
  REMOVE_BACKGROUND = "Remove BG",
  GENERATE_IMAGE = "Generate Image",
  UPSCALE = "Upscale",
  ACCOUNT = "Account Balance",
  SUPPORT = "Support",
}

export enum BannerStance {
  /** Nothing can proceed without a selection. */
  BLOCKING = "blocking",
  /** An empty selection is one of two valid modes; the banner reports, not warns. */
  INFORMATIONAL = "informational",
}

export enum BtnType {
  REMOVE_BG_ACTIVE = "remove-bg-active",
  REMOVE_BG_NO_CREDITS = "remove-bg-no-credits",
  REMOVE_BG_DISABLED = "remove-bg-disabled",
  UPSCALE_ACTIVE = "upscale-active",
  UPSCALE_NO_CREDITS = "upscale-no-credits",
  UPSCALE_DISABLED = "upscale-disabled",
  GENERATE_IMAGE_ACTIVE = "generate-image-active",
  GENERATE_IMAGE_NO_CREDITS = "generate-image-no-credits",
  GENERATE_IMAGE_DISABLED = "generate-image-disabled",
  EDIT_IMAGE_ACTIVE = "generate-image-active edit-image-active",
  EDIT_IMAGE_NO_CREDITS = "generate-image-no-credits edit-image-no-credits",
  EDIT_IMAGE_DISABLED = "generate-image-disabled edit-image-disabled",
  CONTINUE = "continue",
  CONTINUE_DISABLED = "continue-disabled",
  BUY_MORE = "buy-more",
  ADD_CREDITS = "add-credits",
  NEW_KEY = "new-key",
  SUBMIT_ACTIVE = "submit-active",
  SUBMIT_DISABLED = "submit-disabled",
  REMOVE_KEY = "remove-key",

  SIGN_IN = "sign-in-btn",
  SIGN_IN_DISABLED = "sign-in-disabled",
  SIGN_IN_RETRY = "sign-in-retry",
  SIGN_OUT = "sign-out-btn",
  CANCEL = "cancel-btn",
  USE_API_KEY = "use-api-key",
  REOPEN_BROWSER = "reopen-browser",
}

export {};
