import React, { useState } from "react";
import Selector from "@components/Selector/Selector";
import { enhanceImage, refreshBalance, sendMessageToSandBox } from "@api/index";
import {
  FIGMA_MAX_IMAGE_DIMENSION,
  PROCESSING_IMAGE,
  TYPE_NOTIFY,
  UPSCALE_FAILED_ERR,
  UPSCALE_FORMAT_OPTIONS,
  DEFAULT_UPSCALE_FORMAT,
  WIDGET_HEIGHT_UPSCALE_WITH_KEY,
  WIDGET_HEIGHT_UPSCALE_ADVANCED,
} from "@constants/index";
import { Button, ImageSelectionBanner, LoadingSpinner, PanelFooter } from "@components/index";
import { SelectField } from "@ui/index";
import usePluginHeight from "@hooks/usePluginHeight";
import useSelectedImage, { describeBytesFailure } from "@hooks/useSelectedImage";
import { useCredential } from "../../context/CredentialContext";
import resolveActionButton from "@utils/actionButton";
import { withCredentialRescue } from "@utils/credentialRescue";
import { applyImageToCanvas } from "@utils/placement";
import { BannerStance, BtnType } from "@app-types/enums";
import "./styles.scss";
import type { CredentialInput } from "@app-types/credential";

interface UpscaleProps {
  gottenKey: CredentialInput;
  isCreditsInsufficient: boolean;
  balanceKnown?: boolean;
  isOffline: boolean;
}
const options = ["2", "4", "6", "8"];

/**
 * The factors that can actually produce a placeable result for this layer.
 *
 * Nothing used to bound these. Factors run to 8x with no relation to the source, so
 * 8x on a 600px layer is a guaranteed failure *after* payment: the API returns a
 * 4800px image and `figma.createImage` refuses anything over 4096. Offering only the
 * factors that fit turns a post-payment error into an option that was never there.
 *
 * The descriptor carries the layer's *layout* size, which is the best figure
 * available on this side of the seam and is usually the image's own resolution for a
 * photo dropped into Figma. It can understate a large image scaled down inside a
 * small frame — that case still fails, but it fails at the API's own megapixel
 * ceiling with a 422 that names the factor to avoid, which is a usable message.
 */
const usableFactors = (width: number, height: number): string[] => {
  const longestSide = Math.max(width, height);
  if (!longestSide) return options;
  const fitting = options.filter(
    (factor) => longestSide * Number(factor) <= FIGMA_MAX_IMAGE_DIMENSION
  );
  // Never offer an empty selector: the layer is already at or past the ceiling, so
  // the smallest factor is shown and the API gets to explain why it will not go.
  return fitting.length ? fitting : [options[0]];
};

const Upscale: React.FC<UpscaleProps> = ({
  gottenKey,
  balanceKnown = true,
  isCreditsInsufficient,
  isOffline,
}) => {
  const { selection, hasImage, descriptor, takeImage } = useSelectedImage();
  const [loading, setLoading] = useState<boolean>(false);

  const { getCredential, refreshCredential } = useCredential();
  const credentialSource = () => getCredential() ?? gottenKey;
  const rescue = {
    credential: getCredential,
    refresh: refreshCredential,
    fallback: gottenKey,
  };


  const [scaleFactor, setScaleFactor] = useState(2);
  const factorOptions = usableFactors(descriptor?.width ?? 0, descriptor?.height ?? 0);
  const maxFactor = Number(factorOptions[factorOptions.length - 1]);
  // Derived, not stored. Selecting a smaller layer narrows the list under a factor
  // the user already picked, and the panel must show what it will actually send.
  const effectiveFactor = Math.min(scaleFactor, maxFactor);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);
  const [format, setFormat] = useState<string>(DEFAULT_UPSCALE_FORMAT);

  usePluginHeight(
    showAdvancedSettings ? WIDGET_HEIGHT_UPSCALE_ADVANCED : WIDGET_HEIGHT_UPSCALE_WITH_KEY
  );

  const handleSubmit = async () => {
    // `loading` belongs in this guard: the overlay blocks the mouse but not the
    // keyboard, so a second Enter on the focused button bought a second upscale.
    if (
      !hasImage ||
      !gottenKey ||
      !scaleFactor ||
      !balanceKnown ||
      isCreditsInsufficient ||
      isOffline ||
      loading
    ) {
      return;
    }
    setLoading(true);

    // Read the bytes and capture the nodeId together, at press time. The old code
    // used bytes held in App state and let the sandbox find the target by reading
    // the live selection when the result came back.
    const picked = await takeImage();
    if (!picked.ok) {
      sendMessageToSandBox(false, describeBytesFailure(picked), TYPE_NOTIFY);
      setLoading(false);
      return;
    }

    const factor = effectiveFactor;

    sendMessageToSandBox(true, PROCESSING_IMAGE, TYPE_NOTIFY);

    const response = await withCredentialRescue(
      (credential) => enhanceImage(picked.bytes, credential, factor, format),
      rescue
    );
    if (!response.success) {
      // The API's own reason, not a fixed string. A 422 here names the ceiling
      // that was hit ("would exceed 23MP after 2x upscale"), which tells the user
      // to drop the factor; the old constant told them to try again, and the
      // identical request fails identically every time.
      sendMessageToSandBox(false, response.msg || UPSCALE_FAILED_ERR, TYPE_NOTIFY);
      setLoading(false);
      return;
    }

    // No setImageBytes(result) here. That made the upscaled output the input to
    // the next press, so pressing Upscale twice upscaled the upscale — a second
    // charge on the wrong image.
    //
    // Awaited, not fired and forgotten: the write happens in the sandbox and can
    // fail there (a locked layer, a result over Figma's 4096 ceiling), and the
    // loading state has to survive until it is actually done.
    await applyImageToCanvas({
      bytes: response.msg,
      nodeId: picked.nodeId,
      scaleFactor: factor,
    });
    setLoading(false);
    // Re-read the balance rather than trusting the response header.
    // `x-picsart-credit-available` is the balance at the moment the request was
    // AUTHORIZED, measured pre-charge on this endpoint too — so posting it left the
    // credits strip one job stale, and `isCreditsInsufficient` derives from it.
    await refreshBalance(credentialSource());
  };

  const handleOnChange = (val: string) => {
    setScaleFactor(Number(val));
  };

  const { btnType, cb } = resolveActionButton({
    isOffline,
    hasKey: !!gottenKey,
    isReady: balanceKnown && hasImage,
    isCreditsInsufficient,
    active: BtnType.UPSCALE_ACTIVE,
    noCredits: BtnType.UPSCALE_NO_CREDITS,
    disabled: BtnType.UPSCALE_DISABLED,
    onAction: handleSubmit,
  });

  return (
    <div className="upscale-container">
      {/* Upscale needs the same selection indicator Remove BG has — it was the one
          tab that disabled its button on an empty selection without ever saying why.
          Blocking stance: here a selection is a precondition, not a mode, so nothing
          can happen without one and the warning is honest. */}
      <ImageSelectionBanner selection={selection} stance={BannerStance.BLOCKING} />
      <div className="upscale-header">
        <span className="header-text">Choose enhance factor</span>
        <Selector
          onChange={handleOnChange}
          // Only the factors whose result Figma can actually hold. Unbounded, an 8x
          // on a small layer was a guaranteed failure after payment.
          options={factorOptions}
          text={String(effectiveFactor)}
          tabIndex={0}
        />
      </div>
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

        <div className={`advanced-options ${showAdvancedSettings ? "visible" : ""}`}>
          <SelectField
            label="Format"
            value={format}
            options={UPSCALE_FORMAT_OPTIONS}
            // The panel stays in the DOM when collapsed, so the control is taken
            // out of the tab order rather than left focusable but invisible.
            tabIndex={showAdvancedSettings ? 0 : -1}
            onChange={setFormat}
          />
        </div>
      </div>

      <p className="upscale-text">
        Enhance Factor adjusts the level of improvement, such as image quality
        and resolution
      </p>
      <PanelFooter>
        <Button type={btnType} cb={cb} tabIndex={0} />
        {loading && <LoadingSpinner message={PROCESSING_IMAGE} />}
      </PanelFooter>
    </div>
  );
};

export default Upscale;
