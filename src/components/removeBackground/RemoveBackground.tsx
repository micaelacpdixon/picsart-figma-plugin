import React, { useState } from "react";
import { removeBackgroundApi, refreshBalance, sendMessageToSandBox } from "@api/index";
import {
  PROCESSING_IMAGE,
  REMOVE_BG_FAILED_ERR,
  TYPE_NOTIFY,
  REMOVEBG_MODEL_OPTIONS,
  DEFAULT_REMOVEBG_MODEL,
  REMOVEBG_OUTPUT_TYPE_OPTIONS,
  DEFAULT_REMOVEBG_OUTPUT_TYPE,
  REMOVEBG_FORMAT_OPTIONS,
  DEFAULT_REMOVEBG_FORMAT,
  REMOVEBG_SCALE_OPTIONS,
  DEFAULT_REMOVEBG_SCALE,
  REMOVEBG_SHADOW_OPTIONS,
  DEFAULT_REMOVEBG_SHADOW,
  REMOVEBG_SHADOW_DISABLED,
  REMOVEBG_SHADOW_CUSTOM,
  REMOVEBG_OUTPUT_TYPE_CUTOUT,
  DEFAULT_REMOVEBG_BG_BLUR,
  DEFAULT_REMOVEBG_STROKE_SIZE,
  DEFAULT_REMOVEBG_STROKE_COLOR,
  DEFAULT_REMOVEBG_STROKE_OPACITY,
  DEFAULT_REMOVEBG_SHADOW_OPACITY,
  DEFAULT_REMOVEBG_SHADOW_BLUR,
  DEFAULT_REMOVEBG_SHADOW_OFFSET,
  REMOVEBG_PERCENT_MIN,
  REMOVEBG_PERCENT_MAX,
  REMOVEBG_OFFSET_MIN,
  REMOVEBG_OFFSET_MAX,
  WIDGET_HEIGHT_WITH_KEY,
  WIDGET_HEIGHT_REMOVE_BG_ADVANCED,
} from "@constants/index";
import {
  Button,
  ImageSelectionBanner,
  LoadingSpinner,
  PanelFooter,
} from "@components/index";
import { SelectField, NumberField } from "@ui/index";
import usePluginHeight from "@hooks/usePluginHeight";
import useSelectedImage, { describeBytesFailure } from "@hooks/useSelectedImage";
import { useCredential } from "../../context/CredentialContext";
import resolveActionButton from "@utils/actionButton";
import { withCredentialRescue } from "@utils/credentialRescue";
import { applyImageToCanvas } from "@utils/placement";
import { BannerStance, BtnType } from "@app-types/enums";
import "./styles.scss";
import type { CredentialInput } from "@app-types/credential";

interface RemoveBackgroundProps {
  gottenKey: CredentialInput;
  isCreditsInsufficient: boolean;
  balanceKnown?: boolean;
  isOffline: boolean;
}

const RemoveBackground: React.FC<RemoveBackgroundProps> = ({
  gottenKey,
  balanceKnown = true,
  isCreditsInsufficient,
  isOffline,
}) => {
  const { selection, hasImage, takeImage } = useSelectedImage();
  const [loading, setLoading] = useState<boolean>(false);

  const { getCredential, refreshCredential } = useCredential();
  const credentialSource = () => getCredential() ?? gottenKey;
  const rescue = {
    credential: getCredential,
    refresh: refreshCredential,
    fallback: gottenKey,
  };

  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);

  const [model, setModel] = useState<string>(DEFAULT_REMOVEBG_MODEL);
  const [outputType, setOutputType] = useState<string>(DEFAULT_REMOVEBG_OUTPUT_TYPE);
  const [format, setFormat] = useState<string>(DEFAULT_REMOVEBG_FORMAT);
  const [scale, setScale] = useState<string>(DEFAULT_REMOVEBG_SCALE);
  const [autoCenter, setAutoCenter] = useState<boolean>(false);
  const [bgColor, setBgColor] = useState<string>("");
  const [bgBlur, setBgBlur] = useState<number>(DEFAULT_REMOVEBG_BG_BLUR);
  const [strokeSize, setStrokeSize] = useState<number>(DEFAULT_REMOVEBG_STROKE_SIZE);
  const [strokeColor, setStrokeColor] = useState<string>(DEFAULT_REMOVEBG_STROKE_COLOR);
  const [strokeOpacity, setStrokeOpacity] = useState<number>(DEFAULT_REMOVEBG_STROKE_OPACITY);
  const [shadow, setShadow] = useState<string>(DEFAULT_REMOVEBG_SHADOW);
  const [shadowOpacity, setShadowOpacity] = useState<number>(DEFAULT_REMOVEBG_SHADOW_OPACITY);
  const [shadowBlur, setShadowBlur] = useState<number>(DEFAULT_REMOVEBG_SHADOW_BLUR);
  const [shadowOffsetX, setShadowOffsetX] = useState<number>(DEFAULT_REMOVEBG_SHADOW_OFFSET);
  const [shadowOffsetY, setShadowOffsetY] = useState<number>(DEFAULT_REMOVEBG_SHADOW_OFFSET);

  // A mask is a black-and-white matte: background, stroke and shadow options
  // have nothing to apply to, so they are neither shown nor sent.
  const isCutout = outputType === REMOVEBG_OUTPUT_TYPE_CUTOUT;

  usePluginHeight(
    showAdvancedSettings ? WIDGET_HEIGHT_REMOVE_BG_ADVANCED : WIDGET_HEIGHT_WITH_KEY
  );

  const processImage = async () => {
    // `loading` is in this guard because the loading overlay blocks the mouse but
    // not the keyboard, so a second Enter or Space on the focused button started a
    // second billable call.
    if (!balanceKnown || !hasImage || !gottenKey || isCreditsInsufficient || isOffline || loading) {
      return;
    }
    setLoading(true);

    // Bytes are read here, not held in shared state, and the nodeId is captured at
    // the same moment. That pairing is the point: the result goes back to the layer
    // it came from, even if the user clicks elsewhere while the call is in flight.
    const picked = await takeImage();
    if (!picked.ok) {
      // Names which failure it was. "The layer was deleted" and "that layer holds
      // no image" used to arrive as the same generic sentence.
      sendMessageToSandBox(false, describeBytesFailure(picked), TYPE_NOTIFY);
      setLoading(false);
      return;
    }

    sendMessageToSandBox(true, PROCESSING_IMAGE, TYPE_NOTIFY);

    const response = await withCredentialRescue(
      (credential) =>
        removeBackgroundApi(picked.bytes, credential, {
          model,
          output_type: outputType,
          format,
          scale: isCutout ? scale : undefined,
          auto_center: isCutout && autoCenter,
          bg_color: isCutout ? bgColor.trim() || undefined : undefined,
          bg_blur: isCutout ? bgBlur : undefined,
          stroke_size: isCutout ? strokeSize : undefined,
          stroke_color: strokeColor,
          stroke_opacity: strokeOpacity,
          shadow: isCutout ? shadow : undefined,
          shadow_opacity: shadowOpacity,
          shadow_blur: shadowBlur,
          shadow_offset_x: shadowOffsetX,
          shadow_offset_y: shadowOffsetY,
        }),
      rescue
    );
    if (!response.success) {
      // Show what the API said. Validation errors here name the offending
      // setting, which a fixed "please try again" hid behind a retry that
      // charges nothing but changes nothing either.
      sendMessageToSandBox(false, response.msg || REMOVE_BG_FAILED_ERR, TYPE_NOTIFY);
      setLoading(false);
      return;
    }

    // The result is NOT written back into shared selection state. It used to be
    // (setImageBytes(response.msg)), which made one variable both the input and
    // the output of a paid call: pressing the button again re-processed the
    // previous result instead of the source layer, and charged for it.
    // Awaited. The write happens in the sandbox and can fail there, so the loading
    // state has to survive until the canvas has actually changed.
    await applyImageToCanvas({ bytes: response.msg, nodeId: picked.nodeId });
    // Re-read rather than trusting the response header — it is pre-charge. See
    // extractCreditsFromResponse in src/api/index.ts for the measurement.
    await refreshBalance(credentialSource());
    setLoading(false);
  };

  const { btnType, cb } = resolveActionButton({
    isOffline,
    hasKey: !!gottenKey,
    isReady: balanceKnown && hasImage,
    isCreditsInsufficient,
    active: BtnType.REMOVE_BG_ACTIVE,
    noCredits: BtnType.REMOVE_BG_NO_CREDITS,
    disabled: BtnType.REMOVE_BG_DISABLED,
    onAction: processImage,
  });

  return (
    <div className="removebg-container">
      {/* Blocking: without a selected image this tab can do nothing at all. */}
      <ImageSelectionBanner selection={selection} stance={BannerStance.BLOCKING} />

      <div className="advanced-settings">
        <label
          className="settings-toggle"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
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
          <div className="removebg-advanced-options">
            <SelectField
              label="Model"
              value={model}
              options={REMOVEBG_MODEL_OPTIONS}
              tabIndex={0}
              wide
              onChange={setModel}
            />
            <SelectField
              label="Output type"
              value={outputType}
              options={REMOVEBG_OUTPUT_TYPE_OPTIONS}
              tabIndex={0}
              onChange={setOutputType}
            />
            <SelectField
              label="Format"
              value={format}
              options={REMOVEBG_FORMAT_OPTIONS}
              tabIndex={0}
              onChange={setFormat}
            />

            {isCutout && (
              <>
                <SelectField
                  label="Scale"
                  value={scale}
                  options={REMOVEBG_SCALE_OPTIONS}
                  tabIndex={0}
                  onChange={setScale}
                />
                <NumberField
                  label="Background blur"
                  value={bgBlur}
                  min={REMOVEBG_PERCENT_MIN}
                  max={REMOVEBG_PERCENT_MAX}
                  tabIndex={0}
                  onChange={setBgBlur}
                />

                <div className="option-group wide">
                  <label className="option-label">Background color</label>
                  <input
                    className="option-input"
                    type="text"
                    value={bgColor}
                    tabIndex={0}
                    onChange={(e) => setBgColor(e.target.value)}
                    placeholder="e.g. #82d5fa or blue (optional)"
                  />
                </div>

                <label className="option-checkbox wide">
                  <input
                    type="checkbox"
                    checked={autoCenter}
                    tabIndex={0}
                    onChange={(e) => setAutoCenter(e.target.checked)}
                  />
                  <span>Auto-center subject</span>
                </label>

                <NumberField
                  label="Stroke size"
                  value={strokeSize}
                  min={REMOVEBG_PERCENT_MIN}
                  max={REMOVEBG_PERCENT_MAX}
                  tabIndex={0}
                  onChange={setStrokeSize}
                />

                {strokeSize > 0 && (
                  <>
                    <div className="option-group">
                      <label className="option-label">Stroke color</label>
                      <input
                        className="option-input"
                        type="text"
                        value={strokeColor}
                        tabIndex={0}
                        onChange={(e) => setStrokeColor(e.target.value)}
                        placeholder="e.g. FFFFFF"
                      />
                    </div>
                    <NumberField
                      label="Stroke opacity"
                      value={strokeOpacity}
                      min={REMOVEBG_PERCENT_MIN}
                      max={REMOVEBG_PERCENT_MAX}
                      tabIndex={0}
                      onChange={setStrokeOpacity}
                    />
                  </>
                )}

                <SelectField
                  label="Shadow"
                  value={shadow}
                  options={REMOVEBG_SHADOW_OPTIONS}
                  tabIndex={0}
                  wide
                  onChange={setShadow}
                />

                {shadow !== REMOVEBG_SHADOW_DISABLED && (
                  <>
                    <NumberField
                      label="Shadow opacity"
                      value={shadowOpacity}
                      min={REMOVEBG_PERCENT_MIN}
                      max={REMOVEBG_PERCENT_MAX}
                      tabIndex={0}
                      onChange={setShadowOpacity}
                    />
                    <NumberField
                      label="Shadow blur"
                      value={shadowBlur}
                      min={REMOVEBG_PERCENT_MIN}
                      max={REMOVEBG_PERCENT_MAX}
                      tabIndex={0}
                      onChange={setShadowBlur}
                    />
                  </>
                )}

                {shadow === REMOVEBG_SHADOW_CUSTOM && (
                  <>
                    <NumberField
                      label="Shadow offset X"
                      value={shadowOffsetX}
                      min={REMOVEBG_OFFSET_MIN}
                      max={REMOVEBG_OFFSET_MAX}
                      tabIndex={0}
                      onChange={setShadowOffsetX}
                    />
                    <NumberField
                      label="Shadow offset Y"
                      value={shadowOffsetY}
                      min={REMOVEBG_OFFSET_MIN}
                      max={REMOVEBG_OFFSET_MAX}
                      tabIndex={0}
                      onChange={setShadowOffsetY}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Portalled outside the scroller. This panel is the tallest of the three with
          its advanced settings open, so it is the one where the primary action most
          often scrolled out of sight. */}
      <PanelFooter>
        <Button type={btnType} cb={cb} tabIndex={0} />
        {loading && <LoadingSpinner message={PROCESSING_IMAGE} />}
      </PanelFooter>
    </div>
  );
};

export default RemoveBackground;
