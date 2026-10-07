import React, { useState, useEffect, useRef } from "react";
import {
  generateImage,
  editImage,
  downloadGeneratedImages,
  sendMessageToSandBox,
  refreshBalance,
  isAbortError,
} from "@api/index";
import pollInference from "@api/pollInference";
import {
  GENERATING_IMAGE,
  EDITING_IMAGE,
  TYPE_NOTIFY,
  STYLE_OPTIONS,
  ASPECT_RATIO_OPTIONS,
  ASPECT_RATIO_DIMENSIONS,
  PRESET_TAGS,
  DEFAULT_STYLE,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NEGATIVE_PROMPT,
  DEFAULT_IMAGE_COUNT,
  IMAGE_COUNT_OPTIONS,
  TEXT2IMAGE_MODEL_OPTIONS,
  DEFAULT_TEXT2IMAGE_MODEL,
  EDIT_IMAGE_MODEL_OPTIONS,
  DEFAULT_EDIT_IMAGE_MODEL,
  EDIT_IMAGE_COUNT_OPTIONS,
  DEFAULT_EDIT_IMAGE_COUNT,
  EDIT_IMAGE_FORMAT_OPTIONS,
  DEFAULT_EDIT_IMAGE_FORMAT,
  EDIT_PROMPT_STARTERS,
  EDIT_IMAGE_FAILED_ERR,
  GENERATE_IMAGE_FAILED_ERR,
  SOURCE_TOO_SMALL_ERR,
  NO_IMAGE_IN_NODE_ERR,
  FIGMA_MAX_IMAGE_DIMENSION,
  MIN_SOURCE_DIMENSION,
  EDITIMAGE_POLL_PATHS,
  GENERATEIMAGE,
  WIDGET_HEIGHT_GENERATE_IMAGE,
  WIDGET_HEIGHT_GENERATE_IMAGE_ADVANCED,
  getNextPromptExample,
} from "@constants/index";
import {
  EDIT_PROMPT_LABEL,
  EDIT_PROMPT_PLACEHOLDER,
  EDIT_PROMPT_TITLE,
  EDIT_PROMPT_TOOLTIP,
  GENERATE_PROMPT_LABEL,
  GENERATE_PROMPT_PLACEHOLDER,
  GENERATE_PROMPT_TITLE,
  GENERATE_PROMPT_TOOLTIP,
  LOADING_EDITING,
  LOADING_GENERATING,
  LOADING_PLACING,
  LOADING_UPLOADING,
  editRunSummary,
  generateRunSummary,
} from "@ui_constants/index";
import { Button, ImageSelectionBanner, LoadingSpinner, PanelFooter } from "@components/index";
import { SelectField } from "@ui/index";
import usePluginHeight from "@hooks/usePluginHeight";
import useSelectedImage, { describeBytesFailure } from "@hooks/useSelectedImage";
import resolveActionButton from "@utils/actionButton";
import { withCredentialRescue } from "@utils/credentialRescue";
import { prepareEditSource } from "@utils/imageBinary";
import { placeEditedImages, placeGeneratedImages } from "@utils/placement";
import { BannerStance, BtnType } from "@app-types/enums";
import "./styles.scss";
import type { CredentialInput } from "@app-types/credential";
import { useCredential } from "../../context/CredentialContext";

// The worker rejects a prompt over 10000 characters. Enforced in the control so a
// paste cannot spend a request proving it.
const PROMPT_MAX_LENGTH = 10000;

interface GenerateImageProps {
  gottenKey: CredentialInput;
  isCreditsInsufficient: boolean;
  balanceKnown?: boolean;
  isOffline: boolean;
}

const GenerateImage: React.FC<GenerateImageProps> = ({
  gottenKey,
  balanceKnown = true,
  isCreditsInsufficient,
  isOffline,
}) => {
  const { selection, hasImage, isUnknown, takeImage } = useSelectedImage();
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [runSummary, setRunSummary] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);
  const [aspectRatio, setAspectRatio] = useState<string>(DEFAULT_ASPECT_RATIO);
  const [style, setStyle] = useState<string>(DEFAULT_STYLE);
  const [count, setCount] = useState<number>(DEFAULT_IMAGE_COUNT);
  const [editCount, setEditCount] = useState<number>(DEFAULT_EDIT_IMAGE_COUNT);
  const [editFormat, setEditFormat] = useState<string>(DEFAULT_EDIT_IMAGE_FORMAT);
  const [model, setModel] = useState<string>(DEFAULT_TEXT2IMAGE_MODEL);
  const [editModel, setEditModel] = useState<string>(DEFAULT_EDIT_IMAGE_MODEL);
  const [currentPromptIndex, setCurrentPromptIndex] = useState<number>(-1);
  const [showInfoTooltip, setShowInfoTooltip] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The mode. One tab, two endpoints, keyed on whether an image is selected.
   *
   * `isUnknown` is deliberately NOT edit mode. Between the panel mounting and the
   * sandbox's first selection report there is a window in which nothing is known, and
   * guessing text-to-image there would mean the button offered — and charged for — the
   * wrong operation on every single open.
   */
  const isEditMode = hasImage;

  // The expanded prompt hides the advanced panel, so it needs no extra room.
  usePluginHeight(
    showAdvancedSettings && !isFullscreen
      ? WIDGET_HEIGHT_GENERATE_IMAGE_ADVANCED
      : WIDGET_HEIGHT_GENERATE_IMAGE
  );

  // The advanced panel used two booleans and a setTimeout(10) to stagger its
  // appearance. Upscale.tsx does the same job with one boolean and a CSS class,
  // which is the pattern adopted here: the second boolean and the timer are gone,
  // so there is no window where the two disagree about whether the panel is open.

  /**
   * One abort controller for the whole in-flight job, cleared on unmount.
   *
   * The previous version flipped a local `isPolling` boolean that the poll chain's own
   * closure kept alive past unmount, so the fetches carried on and `setLoading` fired
   * on a component that no longer existed. An AbortController cancels the request
   * rather than ignoring its answer.
   */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Synchronous double-submit guard.
   *
   * `loading` is React state, so two Enter presses in the same tick both read `false`
   * and both start a billable job. A ref is written before the first await.
   */
  const inFlight = useRef(false);

  const stopWork = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  useEffect(() => stopWork, []);

  /**
   * Clear the previous run's summary as soon as the request changes.
   *
   * Without this the panel is byte-identical after a run: same prompt, same enabled
   * button, no record that anything happened — which is a duplicate-charge trap even
   * before edit mode exists. Switching mode also invalidates it, because the summary
   * describes work on a layer that may no longer be selected.
   */
  useEffect(() => setRunSummary(""), [prompt, isEditMode]);

  const { getCredential, refreshCredential } = useCredential();
  const credentialSource = () => getCredential() ?? gottenKey;
  const rescue = {
    credential: getCredential,
    refresh: refreshCredential,
    fallback: gottenKey,
  };

  const finish = () => {
    abortRef.current = null;
    inFlight.current = false;
    setLoading(false);
    setLoadingMessage("");
    // Re-read the balance once per run, at the end.
    //
    // Two reasons this cannot be the response header. It is the balance at the moment
    // the request was AUTHORIZED — measured pre-charge — and for an async job the
    // charge does not land until the job completes, so the 202 header is stale twice
    // over. Measured 2026-08-12: balance 865, 202 header 865, balance after 862.
    //
    // In `finish` rather than on the success path, because a job can fail after being
    // charged and the user needs to see that the credits went.
    if (gottenKey) void refreshBalance(credentialSource());
  };

  /** Text-to-image: an accepted job, then poll, then place in the gallery frame. */
  const runGenerate = async (signal: AbortSignal) => {
    const dimensions =
      ASPECT_RATIO_DIMENSIONS[aspectRatio as keyof typeof ASPECT_RATIO_DIMENSIONS];

    // Gated on the style VALUE, not on whether the panel is open. It used to append
    // the style to the prompt only while the panel was visible, while sending `style`
    // as a request parameter regardless — so collapsing the panel silently changed the
    // request without changing anything the user saw.
    const hasStyle = !!style && style !== DEFAULT_STYLE;

    let finalPrompt = prompt;
    if (hasStyle && !finalPrompt.toLowerCase().includes(style.toLowerCase())) {
      finalPrompt = `${prompt}, ${style} style`;
    }

    setLoadingMessage(LOADING_GENERATING);
    sendMessageToSandBox(true, GENERATING_IMAGE, TYPE_NOTIFY);

    const response = await withCredentialRescue(
      (credential) =>
        generateImage(finalPrompt, credential, {
          width: dimensions.width,
          height: dimensions.height,
          style: hasStyle ? style : "",
          negative_prompt: DEFAULT_NEGATIVE_PROMPT,
          count,
          model,
        }),
      rescue
    );

    if (!response.success || !response.inferenceId) {
      sendMessageToSandBox(false, response.msg || GENERATE_IMAGE_FAILED_ERR, TYPE_NOTIFY);
      return;
    }

    const outcome = await pollInference({
      paths: [`${GENERATEIMAGE}/inferences/`],
      inferenceId: response.inferenceId,
      credential: credentialSource,
      refresh: refreshCredential,
      transient: GENERATE_IMAGE_FAILED_ERR,
      rejected: GENERATE_IMAGE_FAILED_ERR,
      signal,
    });

    if (outcome.status !== "finished") {
      sendMessageToSandBox(false, outcome.msg, TYPE_NOTIFY);
      return;
    }

    const download = await downloadGeneratedImages(outcome.imageUrls, signal);
    if (!download.success) {
      sendMessageToSandBox(false, download.msg, TYPE_NOTIFY);
      return;
    }

    setLoadingMessage(LOADING_PLACING);
    // Awaited: placement runs in the sandbox and takes seconds for a full batch.
    // `setLoading(false)` used to fire the moment the message was posted, which is
    // why the third loading phase could not previously be built at all.
    const placed = await placeGeneratedImages({
      images: download.images,
      prompt: finalPrompt,
    });
    if (placed.ok) setRunSummary(generateRunSummary(download.images.length));
    if (download.failed > 0) {
      sendMessageToSandBox(
        false,
        `${download.failed} of ${outcome.imageUrls.length} results could not be downloaded.`,
        TYPE_NOTIFY
      );
    }
  };

  /** Image-to-image: upload the selected layer, then place candidates beside it. */
  const runEdit = async (signal: AbortSignal) => {
    setLoadingMessage(LOADING_UPLOADING);

    // Bytes and nodeId captured together, at press time. The nodeId is what stops a
    // result landing on whichever layer happens to be selected a minute later.
    const picked = await takeImage();
    if (!picked.ok) {
      sendMessageToSandBox(false, describeBytesFailure(picked), TYPE_NOTIFY);
      return;
    }

    // One decode measures, floor-checks and (only if needed) downscales. An image
    // already within Figma's ceiling passes through untouched, so a transparent PNG
    // does not get re-encoded and flattened.
    const source = await prepareEditSource(
      picked.bytes,
      FIGMA_MAX_IMAGE_DIMENSION,
      MIN_SOURCE_DIMENSION
    );
    if ("error" in source) {
      sendMessageToSandBox(
        false,
        source.error === "too-small" ? SOURCE_TOO_SMALL_ERR : NO_IMAGE_IN_NODE_ERR,
        TYPE_NOTIFY
      );
      return;
    }
    if (source.downscaled) {
      // Disclosed rather than silent: the user's 6000px layer was uploaded at 4096,
      // and the result tracks what was sent.
      sendMessageToSandBox(
        true,
        `Your layer was scaled to ${source.width}×${source.height} for editing — Figma cannot place an image larger than ${FIGMA_MAX_IMAGE_DIMENSION}px.`,
        TYPE_NOTIFY
      );
    }

    setLoadingMessage(LOADING_EDITING);
    sendMessageToSandBox(true, EDITING_IMAGE, TYPE_NOTIFY);

    const response = await withCredentialRescue(
      (credential) =>
        editImage(source, credential, {
          prompt,
          count: editCount,
          format: editFormat,
          model: editModel,
        }),
      rescue
    );

    if (!response.success) {
      sendMessageToSandBox(false, response.msg || EDIT_IMAGE_FAILED_ERR, TYPE_NOTIFY);
      return;
    }

    // Either the proxy honoured `Prefer: respond-async` and gave us a job to poll, or
    // it ran the edit synchronously and the URLs are already here. Both are success.
    let imageUrls = response.imageUrls;
    if (!imageUrls) {
      const outcome = await pollInference({
        paths: EDITIMAGE_POLL_PATHS,
        inferenceId: response.inferenceId as string,
        credential: credentialSource,
        refresh: refreshCredential,
        transient: EDIT_IMAGE_FAILED_ERR,
        rejected: EDIT_IMAGE_FAILED_ERR,
        signal,
      });
      if (outcome.status !== "finished") {
        sendMessageToSandBox(false, outcome.msg, TYPE_NOTIFY);
        return;
      }
      imageUrls = outcome.imageUrls;
    }

    const download = await downloadGeneratedImages(imageUrls, signal);
    if (!download.success) {
      sendMessageToSandBox(false, download.msg, TYPE_NOTIFY);
      return;
    }

    setLoadingMessage(LOADING_PLACING);
    const placed = await placeEditedImages({
      images: download.images,
      prompt,
      sourceNodeId: picked.nodeId,
    });
    if (placed.ok) setRunSummary(editRunSummary(download.images.length));
    if (download.failed > 0) {
      sendMessageToSandBox(
        false,
        `${download.failed} of ${imageUrls.length} candidates could not be downloaded.`,
        TYPE_NOTIFY
      );
    }
  };

  const handleSubmit = async () => {
    // Also guards the Enter-key path in handleKeyDown, which calls this directly
    // rather than going through the button. Both `loading` and the ref are here: the
    // overlay blocks the mouse but not the keyboard, and two Enter presses in one tick
    // would both read `loading === false`.
    if (inFlight.current) return;
    if (!balanceKnown || !gottenKey || isCreditsInsufficient || isOffline || !prompt.trim() || loading) return;
    // Never in the unknown window: the mode is not yet decided, so which endpoint to
    // charge for is not yet decided either.
    if (isUnknown) return;

    inFlight.current = true;
    setLoading(true);
    setRunSummary("");

    stopWork();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (isEditMode) {
        await runEdit(controller.signal);
      } else {
        await runGenerate(controller.signal);
      }
    } catch (error) {
      // An abort is this component withdrawing, not a failure to report.
      if (!isAbortError(error) && !controller.signal.aborted) {
        console.error("Image request failed:", error);
        sendMessageToSandBox(
          false,
          isEditMode ? EDIT_IMAGE_FAILED_ERR : GENERATE_IMAGE_FAILED_ERR,
          TYPE_NOTIFY
        );
      }
    } finally {
      if (!controller.signal.aborted) finish();
    }
  };

  const handlePresetClick = (preset: string) => {
    if (prompt.trim()) {
      setPrompt((prev) => prev + ", " + preset);
    } else {
      setPrompt(preset);
    }
  };

  /**
   * Edit starters REPLACE the field, text-to-image tags APPEND to it.
   *
   * The two lists are different kinds of thing. "Landscape" is a style word that reads
   * naturally appended to a description; appending it to "make the sky stormy" is
   * nonsense. An edit starter is a whole instruction, so it stands alone.
   */
  const handleStarterClick = (starter: string) => {
    setPrompt(starter);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
  };

  /**
   * Fills in an example, and only when the field is empty.
   *
   * It used to overwrite whatever was typed, unconditionally, with one of nine canned
   * scene descriptions and no undo — a destructive action on a control labelled
   * "Enhance prompt", which is not what enhancing means. The Tab shortcut below always
   * had this right; this is the same rule, and the label now says what it does.
   */
  const handleExampleClick = () => {
    if (prompt.trim()) {
      textareaRef.current?.focus();
      return;
    }
    const { prompt: nextPrompt, nextIndex } = getNextPromptExample(currentPromptIndex);
    setPrompt(nextPrompt);
    setCurrentPromptIndex(nextIndex);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextPrompt.length, nextPrompt.length);
      }
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      // Only insert placeholder text if textarea is empty
      if (!prompt.trim()) {
        e.preventDefault();

        const placeholderText = isEditMode
          ? EDIT_PROMPT_PLACEHOLDER
          : GENERATE_PROMPT_PLACEHOLDER;
        setPrompt(placeholderText);

        // Set cursor position at the end of the inserted text
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = placeholderText.length;
          }
        }, 0);
      }
      // If textarea has content, allow normal tab behavior (don't preventDefault)
      // This will move focus to the next element
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Submit form when Enter is pressed (but not Shift+Enter for new lines)
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInfoClick = () => {
    setShowInfoTooltip(!showInfoTooltip);
  };

  const { btnType, cb } = resolveActionButton({
    isOffline,
    hasKey: !!gottenKey,
    // A typed prompt in both modes. Edit mode additionally needs a selected image,
    // but that is what chose edit mode in the first place — and the unknown window
    // counts as not-ready, so the button cannot offer an operation before the mode
    // that decides its price is known.
    isReady: balanceKnown && !!prompt.trim() && !isUnknown,
    isCreditsInsufficient,
    active: isEditMode ? BtnType.EDIT_IMAGE_ACTIVE : BtnType.GENERATE_IMAGE_ACTIVE,
    noCredits: isEditMode
      ? BtnType.EDIT_IMAGE_NO_CREDITS
      : BtnType.GENERATE_IMAGE_NO_CREDITS,
    disabled: isEditMode ? BtnType.EDIT_IMAGE_DISABLED : BtnType.GENERATE_IMAGE_DISABLED,
    onAction: handleSubmit,
  });

  const promptLabel = isEditMode ? EDIT_PROMPT_LABEL : GENERATE_PROMPT_LABEL;
  const promptTitle = isEditMode ? EDIT_PROMPT_TITLE : GENERATE_PROMPT_TITLE;
  const promptTooltip = isEditMode ? EDIT_PROMPT_TOOLTIP : GENERATE_PROMPT_TOOLTIP;
  const promptPlaceholder = isEditMode
    ? EDIT_PROMPT_PLACEHOLDER
    : GENERATE_PROMPT_PLACEHOLDER;

  // Portalled out of the scroller, so the button's position no longer depends on how
  // much prompt the user has typed or whether the advanced panel is open.
  const actionButton = (
    <PanelFooter>
      <Button type={btnType} cb={cb} tabIndex={0} />
      {runSummary && (
        <p className="run-summary" role="status" aria-live="polite">
          {runSummary}
        </p>
      )}
      {loading && <LoadingSpinner message={loadingMessage} />}
    </PanelFooter>
  );

  return (
    <div className={`generate-image-container ${isFullscreen ? 'expanded' : ''}`}>
      {/* Requirement 2 of the original ask, and the reason it matters most here:
          this is the one tab where the selection silently decides which endpoint the
          user pays for. Informational stance, because an empty selection is a valid
          deliberate mode on this tab rather than something to warn about. */}
      {!isFullscreen && (
        <ImageSelectionBanner selection={selection} stance={BannerStance.INFORMATIONAL} />
      )}
      <div className="prompt-section">
        <div className="prompt-header">
          <div className="prompt-label-container">
            {/* htmlFor + a matching id on the textarea. The label was previously
                just adjacent markup, which associates nothing: a screen reader
                announced the main control of this tab as an unlabelled text area. */}
            <label className="prompt-label" htmlFor="generate-prompt">
              {promptLabel}
            </label>
            <div className="info-icon-container">
              <button
                className="info-icon"
                onClick={handleInfoClick}
                title={promptTitle}
                tabIndex={0}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path style={{fill: "#BD99F8"}} d="M11.3125 14.5C11.3125 14.6492 11.2532 14.7923 11.1477 14.8977C11.0423 15.0032 10.8992 15.0625 10.75 15.0625C10.4019 15.0625 10.0681 14.9242 9.82192 14.6781C9.57578 14.4319 9.4375 14.0981 9.4375 13.75V10C9.4375 9.95027 9.41775 9.90258 9.38258 9.86742C9.34742 9.83225 9.29973 9.8125 9.25 9.8125C9.10082 9.8125 8.95774 9.75324 8.85225 9.64775C8.74676 9.54226 8.6875 9.39918 8.6875 9.25C8.6875 9.10082 8.74676 8.95774 8.85225 8.85225C8.95774 8.74676 9.10082 8.6875 9.25 8.6875C9.5981 8.6875 9.93194 8.82578 10.1781 9.07192C10.4242 9.31806 10.5625 9.6519 10.5625 10V13.75C10.5625 13.7997 10.5823 13.8474 10.6174 13.8826C10.6526 13.9177 10.7003 13.9375 10.75 13.9375C10.8992 13.9375 11.0423 13.9968 11.1477 14.1023C11.2532 14.2077 11.3125 14.3508 11.3125 14.5ZM9.625 6.8125C9.81042 6.8125 9.99168 6.75752 10.1458 6.6545C10.3 6.55149 10.4202 6.40507 10.4911 6.23377C10.5621 6.06246 10.5807 5.87396 10.5445 5.6921C10.5083 5.51025 10.419 5.3432 10.2879 5.21209C10.1568 5.08098 9.98975 4.99169 9.8079 4.95551C9.62604 4.91934 9.43754 4.93791 9.26623 5.00886C9.09493 5.07982 8.94851 5.19998 8.8455 5.35415C8.74248 5.50832 8.6875 5.68958 8.6875 5.875C8.6875 6.12364 8.78627 6.3621 8.96209 6.53791C9.1379 6.71373 9.37636 6.8125 9.625 6.8125ZM19.5625 10C19.5625 11.8913 19.0017 13.7401 17.9509 15.3126C16.9002 16.8852 15.4067 18.1108 13.6594 18.8346C11.9121 19.5584 9.98939 19.7477 8.13445 19.3788C6.27951 19.0098 4.57563 18.099 3.23829 16.7617C1.90095 15.4244 0.990212 13.7205 0.621241 11.8656C0.25227 10.0106 0.441639 8.08791 1.1654 6.34059C1.88917 4.59327 3.11481 3.09981 4.68736 2.04907C6.2599 0.998331 8.10872 0.4375 10 0.4375C12.5352 0.440477 14.9657 1.44891 16.7584 3.24158C18.5511 5.03425 19.5595 7.46478 19.5625 10ZM18.4375 10C18.4375 8.33122 17.9426 6.69992 17.0155 5.31238C16.0884 3.92484 14.7706 2.84338 13.2289 2.20477C11.6871 1.56615 9.99064 1.39906 8.35393 1.72462C6.71721 2.05019 5.21379 2.85378 4.03379 4.03379C2.85378 5.21379 2.05019 6.71721 1.72462 8.35393C1.39906 9.99064 1.56615 11.6871 2.20477 13.2289C2.84338 14.7706 3.92484 16.0884 5.31238 17.0155C6.69992 17.9426 8.33122 18.4375 10 18.4375C12.237 18.435 14.3817 17.5453 15.9635 15.9635C17.5453 14.3817 18.435 12.237 18.4375 10Z" fill="#5A00EE"/>
                </svg>
              </button>
              {showInfoTooltip && <div className="info-tooltip">{promptTooltip}</div>}
            </div>
          </div>
          <button
            className="expand-icon"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Collapse" : "Expand"}
            tabIndex={0}
          >
            {isFullscreen ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path style={{fill: "#BD99F8"}} d="M6.5625 0.9375V6C6.5625 6.14918 6.50324 6.29226 6.39775 6.39775C6.29226 6.50324 6.14918 6.5625 6 6.5625C5.85082 6.5625 5.70774 6.50324 5.60225 6.39775C5.49676 6.29226 5.4375 6.14918 5.4375 6V2.8575L0.3975 7.8975C0.290863 7.99686 0.149819 8.05095 0.00409338 8.04838C-0.141632 8.04581 -0.280673 7.98678 -0.383728 7.88372C-0.486784 7.78066 -0.545815 7.64162 -0.548378 7.49589C-0.550942 7.35017 -0.496849 7.20913 -0.397488 7.1025L4.6425 2.0625H1.5C1.35082 2.0625 1.20774 2.00324 1.10225 1.89775C0.996763 1.79226 0.9375 1.64918 0.9375 1.5C0.9375 1.35082 0.996763 1.20774 1.10225 1.10225C1.20774 0.996763 1.35082 0.9375 1.5 0.9375H6C6.14918 0.9375 6.29226 0.996763 6.39775 1.10225C6.50324 1.20774 6.5625 1.35082 6.5625 1.5V0.9375ZM17.1025 10.8975L12.0625 15.9375H15C15.1492 15.9375 15.2923 15.9968 15.3977 16.1023C15.5032 16.2077 15.5625 16.3508 15.5625 16.5C15.5625 16.6492 15.5032 16.7923 15.3977 16.8977C15.2923 17.0032 15.1492 17.0625 15 17.0625H10.5C10.3508 17.0625 10.2077 17.0032 10.1023 16.8977C9.99676 16.7923 9.9375 16.6492 9.9375 16.5V12C9.9375 11.8508 9.99676 11.7077 10.1023 11.6023C10.2077 11.4968 10.3508 11.4375 10.5 11.4375C10.6492 11.4375 10.7923 11.4968 10.8977 11.6023C11.0032 11.7077 11.0625 11.8508 11.0625 12V15.1425L16.1025 10.1025C16.2091 10.0031 16.3502 9.94905 16.4959 9.95162C16.6416 9.95419 16.7807 10.0132 16.8837 10.1163C16.9868 10.2193 17.0458 10.3584 17.0484 10.5041C17.051 10.6498 16.9969 10.7909 16.8975 10.8975H17.1025Z" fill="#5A00EE"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path style={{fill: "#BD99F8"}} d="M17.0625 1.5V6C17.0625 6.14918 17.0032 6.29226 16.8977 6.39775C16.7923 6.50324 16.6492 6.5625 16.5 6.5625C16.3508 6.5625 16.2077 6.50324 16.1023 6.39775C15.9968 6.29226 15.9375 6.14918 15.9375 6V2.8575L10.8975 7.8975C10.7909 7.99686 10.6498 8.05095 10.5041 8.04838C10.3584 8.04581 10.2193 7.98678 10.1163 7.88372C10.0132 7.78066 9.95419 7.64162 9.95162 7.49589C9.94905 7.35017 10.0031 7.20913 10.1025 7.1025L15.1425 2.0625H12C11.8508 2.0625 11.7077 2.00324 11.6023 1.89775C11.4968 1.79226 11.4375 1.64918 11.4375 1.5C11.4375 1.35082 11.4968 1.20774 11.6023 1.10225C11.7077 0.996763 11.8508 0.9375 12 0.9375H16.5C16.6492 0.9375 16.7923 0.996763 16.8977 1.10225C17.0032 1.20774 17.0625 1.35082 17.0625 1.5ZM7.1025 10.1025L2.0625 15.1425V12C2.0625 11.8508 2.00324 11.7077 1.89775 11.6023C1.79226 11.4968 1.64918 11.4375 1.5 11.4375C1.35082 11.4375 1.20774 11.4968 1.10225 11.6023C0.996763 11.7077 0.9375 11.8508 0.9375 12V16.5C0.9375 16.6492 0.996763 16.7923 1.10225 16.8977C1.20774 17.0032 1.35082 17.0625 1.5 17.0625H6C6.14918 17.0625 6.29226 17.0032 6.39775 16.8977C6.50324 16.7923 6.5625 16.6492 6.5625 16.5C6.5625 16.3508 6.50324 16.2077 6.39775 16.1023C6.29226 15.9968 6.14918 15.9375 6 15.9375H2.8575L7.8975 10.8975C7.99686 10.7909 8.05095 10.6498 8.04838 10.5041C8.04581 10.3584 7.98678 10.2193 7.88372 10.1163C7.78066 10.0132 7.64162 9.95419 7.49589 9.95162C7.35017 9.94905 7.20913 10.0031 7.1025 10.1025Z" fill="#5A00EE"/>
              </svg>
            )}
          </button>
        </div>

        <div className="textarea-container">
          <textarea
            id="generate-prompt"
            className={`prompt-textarea ${isFullscreen ? 'expanded' : ''}`}
            value={prompt}
            onChange={handlePromptChange}
            onKeyDown={handleKeyDown}
            placeholder={promptPlaceholder}
            rows={isFullscreen ? 20 : 4}
            autoFocus={isFullscreen}
            ref={textareaRef}
            tabIndex={0}
            maxLength={PROMPT_MAX_LENGTH}
            // Enter submits and Tab fills in the example, neither of which a
            // keyboard user can discover from the visible "tab" hint alone.
            aria-describedby="generate-prompt-hint"
          />
          <p id="generate-prompt-hint" className="sr-only">
            Press Enter to run, Shift and Enter for a new line, or Tab on an empty
            field to insert an example.
          </p>
          <div className="textarea-icons">
            <button
              className="edit-icon"
              // Renamed from "Enhance prompt", which it never did — it replaced the
              // field with a canned example.
              title="Show an example"
              tabIndex={0}
              onClick={handleExampleClick}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path style={{fill: "#BD99F8"}} fillRule="evenodd" clipRule="evenodd" d="M1.953 0.91L1.638 2.17L0.378 2.485C-0.126 2.611 -0.126 3.329 0.378 3.455L1.638 3.77L1.953 5.03C2.08 5.534 2.797 5.534 2.923 5.03L3.238 3.77L4.498 3.455C5.003 3.329 5.003 2.611 4.498 2.485L3.238 2.17L2.924 0.91C2.797 0.405 2.079 0.405 1.953 0.91ZM9.793 1C9.98053 0.812529 10.2348 0.707214 10.5 0.707214C10.7652 0.707214 11.0195 0.812529 11.207 1L13 2.793C13.1875 2.98053 13.2928 3.23484 13.2928 3.5C13.2928 3.76516 13.1875 4.01947 13 4.207L11.354 5.853L4.5 12.707C4.31251 12.8946 4.0582 12.9999 3.793 13H2C1.73478 13 1.48043 12.8946 1.29289 12.7071C1.10536 12.5196 1 12.2652 1 12V10.207C1.00006 9.9418 1.10545 9.68749 1.293 9.5L8.146 2.646L9.793 1ZM9.207 3L11 4.793L12.293 3.5L10.5 1.707L9.207 3ZM10.293 5.5L8.5 3.707L2 10.207V12H3.793L10.293 5.5ZM10.839 10.87L11.119 9.75C11.202 9.417 11.675 9.417 11.759 9.75L12.039 10.87L13.158 11.15C13.491 11.233 13.491 11.707 13.158 11.79L12.038 12.07L11.758 13.19C11.675 13.522 11.202 13.522 11.118 13.19L10.838 12.07L9.719 11.79C9.386 11.707 9.386 11.233 9.719 11.15L10.839 10.87Z" fill="#5A00EE"/>
              </svg>
            </button>
          </div>
          <div className="tab-hint">tab</div>
        </div>
      </div>

      {!isFullscreen && (
        <>
          {/* Edit starters are whole instructions and replace the field; the
              text-to-image tags are style words and append to it. */}
          <div className="preset-tags">
            {isEditMode
              ? EDIT_PROMPT_STARTERS.map((starter) => (
                  <button
                    key={starter.value}
                    className="preset-tag"
                    onClick={() => handleStarterClick(starter.value)}
                    title={starter.value}
                    tabIndex={0}
                  >
                    {starter.label}
                  </button>
                ))
              : PRESET_TAGS.map((preset, index) => (
                  <button
                    key={index}
                    className="preset-tag"
                    onClick={() => handlePresetClick(preset)}
                    tabIndex={0}
                  >
                    {preset}
                  </button>
                ))}
          </div>

          <div className="advanced-settings">
            <label
              className="settings-toggle"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowAdvancedSettings(!showAdvancedSettings);
                }
              }}
            >
              <input
                type="checkbox"
                checked={showAdvancedSettings}
                onChange={(e) => setShowAdvancedSettings(e.target.checked)}
                tabIndex={-1}
              />
              <span className="toggle-switch"></span>
              <span className="toggle-label">Advanced settings</span>
            </label>

            {showAdvancedSettings && (
              <div className="advanced-options visible">
                {/* Mode-aware, because /painting/edit accepts none of aspect ratio,
                    style or negative prompt. Showing controls the request will not
                    carry is the panel lying about what the user is buying. */}
                {isEditMode ? (
                  <>
                    <SelectField
                      label="Model"
                      value={editModel}
                      options={EDIT_IMAGE_MODEL_OPTIONS}
                      tabIndex={0}
                      onChange={setEditModel}
                    />
                    <SelectField
                      label="Format"
                      value={editFormat}
                      options={EDIT_IMAGE_FORMAT_OPTIONS}
                      tabIndex={0}
                      onChange={setEditFormat}
                    />
                    <SelectField
                      label="Number of candidates"
                      value={editCount}
                      options={EDIT_IMAGE_COUNT_OPTIONS}
                      tabIndex={0}
                      onChange={(value) => setEditCount(Number(value))}
                    />
                  </>
                ) : (
                  <>
                    <SelectField
                      label="Aspect ratio"
                      value={aspectRatio}
                      options={ASPECT_RATIO_OPTIONS}
                      tabIndex={0}
                      onChange={setAspectRatio}
                    />
                    <SelectField
                      label="Style"
                      value={style}
                      options={STYLE_OPTIONS}
                      tabIndex={0}
                      onChange={setStyle}
                    />
                    {/* SelectField handles the SelectOption shape, so the model URNs
                        keep their readable labels. The inline copy here could not —
                        only the RemoveBackground copy of this control ever learned to. */}
                    <SelectField
                      label="Model"
                      value={model}
                      options={TEXT2IMAGE_MODEL_OPTIONS}
                      tabIndex={0}
                      onChange={setModel}
                    />
                    <SelectField
                      label="Number of images"
                      value={count}
                      options={IMAGE_COUNT_OPTIONS}
                      tabIndex={0}
                      onChange={(value) => setCount(Number(value))}
                    />
                  </>
                )}
              </div>
            )}
          </div>

        </>
      )}

      {/* Rendered once, in both modes: PanelFooter puts it in the same place either
          way, so the expanded view no longer needs its own copy with its own padding. */}
      {actionButton}
    </div>
  );
};

export default GenerateImage;
