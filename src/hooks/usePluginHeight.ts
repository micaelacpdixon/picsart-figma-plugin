import { useEffect } from "react";
import { sendMessageToSandBox } from "@api/index";
import { TYPE_RESIZE } from "@constants/index";

/**
 * Asks the sandbox to resize the plugin window whenever `height` changes.
 *
 * Each tab opens at a fixed height and `#root` does not grow with its content,
 * so a panel revealed after mount (advanced settings) would be cut off. Tabs
 * re-run `figma.showUI` with their base height, so nothing needs to undo this
 * on unmount.
 */
const usePluginHeight = (height: number, width?: number) => {
  useEffect(() => {
    sendMessageToSandBox(true, "", TYPE_RESIZE, undefined, { height, ...(width ? { width } : {}) });
  }, [height, width]);
};

export default usePluginHeight;
