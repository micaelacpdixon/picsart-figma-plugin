// @vitest-environment jsdom
//
// The user-visible half of the 422 fix. enhanceImage now returns the API's own
// reason, but that only reaches the user if this component stops replacing it
// with a constant — it used to post UPSCALE_FAILED_ERR ("Please try again") for
// every failure, which is the one instruction that cannot work for a validation
// error: the identical request is refused identically, every time.
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_NOTIFY, DEFAULT_UPSCALE_FORMAT } from "@constants/index";
import { UPSCALE_BTN_TEXT } from "@ui_constants/texts";
import type { SelectionDescriptor, SelectionState } from "@app-types/messages";

const mocks = vi.hoisted(() => ({
  enhanceImage: vi.fn(),
  sendMessageToSandBox: vi.fn(),
  takeImage: vi.fn(),
  applyImageToCanvas: vi.fn(),
  refreshBalance: vi.fn(),
  requestCredentialRefresh: vi.fn(),
  selection: { current: { kind: "unknown" } as SelectionState },
  descriptor: { current: null as SelectionDescriptor | null },
}));

vi.mock("@api/index", () => ({
  enhanceImage: mocks.enhanceImage,
  sendMessageToSandBox: mocks.sendMessageToSandBox,
  refreshBalance: mocks.refreshBalance,
}));

vi.mock("@hooks/useSelectedImage", () => ({
  default: () => ({
    selection: mocks.selection.current,
    hasImage: mocks.selection.current.kind === "image",
    isUnknown: mocks.selection.current.kind === "unknown",
    descriptor: mocks.descriptor.current,
    takeImage: mocks.takeImage,
  }),
  describeBytesFailure: () => "no image",
}));

vi.mock("@utils/placement", () => ({
  applyImageToCanvas: mocks.applyImageToCanvas,
}));

vi.mock("@hooks/usePluginHeight", () => ({ default: () => undefined }));

vi.mock("@utils/credentialBridge", () => ({
  requestCredentialRefresh: mocks.requestCredentialRefresh,
}));

import Upscale from "../Upscale";
import { CredentialProvider, useCredential } from "../../../context/CredentialContext";
import type { CredentialDescriptor } from "@app-types/credential";

const KEY = "test-api-key";
const bytes = () => new Uint8Array([1, 2, 3, 4]);

const descriptor: SelectionDescriptor = {
  nodeId: "1:23",
  nodeType: "RECTANGLE",
  name: "Photo",
  width: 2592,
  height: 3456,
  hasImageFill: true,
  selectionCount: 1,
};

const REASON =
  "Target image resolution would exceed 23MP after 2x upscale. Input image (2592x3456) would produce 35831808 pixels output.";

const notifications = () =>
  mocks.sendMessageToSandBox.mock.calls.filter((call) => call[2] === TYPE_NOTIFY);

// Found by label, not by role: the enhance-factor Selector renders its own
// role="button" elements, so a role query matches several. The action button is a
// div with an onClick wrapping a span, and a click on the span bubbles to it.
// Wrapped in act so the awaited handler's state updates flush before the
// assertions read the mock calls.
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText(UPSCALE_BTN_TEXT));
  });
};

describe("Upscale — what the user is told when a call fails", () => {
  beforeEach(() => {
    // Explicit, because vitest.config.ts does not set `globals: true` and
    // Testing Library only registers its automatic afterEach cleanup when the
    // framework's globals are present. Without this the DOM accumulates across
    // tests in this file and every query matches more than one element.
    cleanup();
    mocks.enhanceImage.mockReset();
    mocks.sendMessageToSandBox.mockReset();
    mocks.takeImage.mockReset();
    mocks.applyImageToCanvas.mockReset();
    mocks.refreshBalance.mockReset();
    mocks.refreshBalance.mockResolvedValue(undefined);
    mocks.selection.current = { kind: "image", descriptor };
    mocks.descriptor.current = null;
    mocks.takeImage.mockResolvedValue({
      ok: true,
      nodeId: descriptor.nodeId,
      bytes: bytes(),
      width: descriptor.width,
      height: descriptor.height,
    });
    mocks.applyImageToCanvas.mockResolvedValue({ ok: true, message: "done" });
  });

  it("shows the API's reason for a 422 rather than a generic retry prompt", async () => {
    mocks.enhanceImage.mockResolvedValue({ success: false, msg: REASON, retryable: false });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    const failure = notifications().filter((call) => call[0] === false);
    expect(failure).toHaveLength(1);
    expect(failure[0][1]).toBe(REASON);
    expect(failure[0][1]).not.toMatch(/try again/i);
  });

  it("does not apply anything to the canvas on a failure", async () => {
    mocks.enhanceImage.mockResolvedValue({ success: false, msg: REASON, retryable: false });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    const applied = mocks.sendMessageToSandBox.mock.calls.filter(
      (call) => call[2] !== TYPE_NOTIFY
    );
    expect(applied).toHaveLength(0);
    expect(mocks.applyImageToCanvas).not.toHaveBeenCalled();
  });

  it("defaults to PNG, the format that survives a transparent layer", async () => {
    mocks.enhanceImage.mockResolvedValue({ success: false, msg: REASON, retryable: false });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(DEFAULT_UPSCALE_FORMAT).toBe("PNG");
    expect(mocks.enhanceImage).toHaveBeenCalledWith(expect.anything(), KEY, 2, "PNG");
  });

  it("does not buy an upscale or open pricing while the balance is unavailable", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Upscale gottenKey={KEY} balanceKnown={false} isCreditsInsufficient={false} isOffline={false} />);
    await press();
    expect(mocks.enhanceImage).not.toHaveBeenCalled();
    expect(mocks.takeImage).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("still charges exactly once per press", async () => {
    mocks.enhanceImage.mockResolvedValue({ success: false, msg: REASON, retryable: false });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.enhanceImage).toHaveBeenCalledTimes(1);
  });
});

describe("Upscale — the enhance factor is bounded by what Figma can place", () => {
  beforeEach(() => {
    cleanup();
    mocks.enhanceImage.mockReset();
    mocks.sendMessageToSandBox.mockReset();
    mocks.takeImage.mockReset();
    mocks.applyImageToCanvas.mockReset();
    mocks.refreshBalance.mockReset();
    mocks.refreshBalance.mockResolvedValue(undefined);
    mocks.selection.current = { kind: "image", descriptor };
    mocks.takeImage.mockResolvedValue({
      ok: true,
      nodeId: descriptor.nodeId,
      bytes: bytes(),
      width: descriptor.width,
      height: descriptor.height,
    });
    mocks.applyImageToCanvas.mockResolvedValue({ ok: true, message: "done" });
    mocks.enhanceImage.mockResolvedValue({ success: true, msg: bytes(), updatedCredits: 5 });
  });

  it("offers every factor for a small layer", () => {
    // 400px longest side: 8x is 3200, inside Figma's 4096 ceiling.
    mocks.descriptor.current = { ...descriptor, width: 400, height: 300 };
    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);

    // The Selector shows only the current value until it is opened, so the offered
    // set is asserted through what a press actually sends, below. Here it is enough
    // that the displayed default is the smallest factor.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("clamps the request for a layer already near the ceiling", async () => {
    // 3000px longest side: even 2x is 6000, past Figma's 4096 limit. The smallest
    // factor is offered anyway so the API can explain the megapixel ceiling, but the
    // panel must never send more than it displays.
    mocks.descriptor.current = { ...descriptor, width: 3000, height: 2000 };
    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.enhanceImage).toHaveBeenCalledWith(expect.anything(), KEY, 2, "PNG");
  });

  it("waits for the placement acknowledgement before clearing its loading state", async () => {
    // A 2x upscale of a large layer can exceed Figma's createImage ceiling, and that
    // failure happens in the sandbox — after the API call has already been paid for.
    mocks.descriptor.current = { ...descriptor, width: 400, height: 300 };
    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.applyImageToCanvas).toHaveBeenCalledTimes(1);
    expect(mocks.applyImageToCanvas.mock.calls[0][0]).toMatchObject({
      nodeId: descriptor.nodeId,
      scaleFactor: 2,
    });
  });
});

describe("Upscale — the credit balance is re-read, not taken from the header", () => {
  beforeEach(() => {
    cleanup();
    mocks.enhanceImage.mockReset();
    mocks.sendMessageToSandBox.mockReset();
    mocks.takeImage.mockReset();
    mocks.applyImageToCanvas.mockReset();
    mocks.refreshBalance.mockReset();
    mocks.refreshBalance.mockResolvedValue(undefined);
    mocks.selection.current = { kind: "image", descriptor };
    mocks.descriptor.current = { ...descriptor, width: 400, height: 300 };
    mocks.takeImage.mockResolvedValue({
      ok: true,
      nodeId: descriptor.nodeId,
      bytes: bytes(),
      width: descriptor.width,
      height: descriptor.height,
    });
    mocks.applyImageToCanvas.mockResolvedValue({ ok: true, message: "done" });
  });

  it("re-reads the balance after a successful call", async () => {
    mocks.enhanceImage.mockResolvedValue({ success: true, msg: bytes(), updatedCredits: 862 });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.refreshBalance).toHaveBeenCalledWith(KEY);
  });

  it("never posts the response's credit header as the new balance", async () => {
    // Measured against the live API on 2026-08-12: `x-picsart-credit-available` is the
    // balance at the moment the request was AUTHORIZED, on the synchronous endpoints as
    // well as on a 202. Posting it left the credits strip one job stale after every
    // operation — and `isCreditsInsufficient` derives from that number, so a user who
    // had just spent their last credit still saw an enabled button and bought a 402.
    mocks.enhanceImage.mockResolvedValue({ success: true, msg: bytes(), updatedCredits: 862 });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    const balancePosts = mocks.sendMessageToSandBox.mock.calls.filter(
      (call) => call[2] === "set-balance"
    );
    expect(balancePosts).toHaveLength(0);
  });

  it("does not re-read the balance when the call failed", async () => {
    // A refused request is not charged, so there is nothing to re-read.
    mocks.enhanceImage.mockResolvedValue({ success: false, msg: REASON, retryable: false });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.refreshBalance).not.toHaveBeenCalled();
  });
});

describe("Upscale — a session that expired while the panel was open", () => {
  const DEAD: CredentialDescriptor = {
    kind: "oauth",
    token: "dead",
    scopes: ["workflows.execute"],
    expiresAt: Date.now() - 1000,
  };
  const FRESH: CredentialDescriptor = {
    kind: "oauth",
    token: "fresh",
    scopes: ["workflows.execute"],
    expiresAt: Date.now() + 3_599_000,
  };

  const expired = {
    success: false as const,
    msg: "Your Picsart sign-in expired. Sign in again to carry on — nothing was charged.",
    retryable: true,
    tokenFailure: "session-expired" as const,
  };

  const Seed: React.FC<{ credential: CredentialDescriptor }> = ({ credential }) => {
    const { setActive } = useCredential();
    React.useEffect(() => setActive(credential, ""), [credential, setActive]);
    return null;
  };

  const mount = (credential: CredentialDescriptor) =>
    render(
      <CredentialProvider>
        <Seed credential={credential} />
        <Upscale gottenKey={credential} isCreditsInsufficient={false} isOffline={false} />
      </CredentialProvider>
    );

  beforeEach(() => {
    cleanup();
    mocks.enhanceImage.mockReset();
    mocks.sendMessageToSandBox.mockReset();
    mocks.takeImage.mockReset();
    mocks.applyImageToCanvas.mockReset();
    mocks.refreshBalance.mockReset();
    mocks.refreshBalance.mockResolvedValue(undefined);
    mocks.requestCredentialRefresh.mockReset();
    mocks.selection.current = { kind: "image", descriptor };
    mocks.descriptor.current = null;
    mocks.takeImage.mockResolvedValue({
      ok: true,
      nodeId: descriptor.nodeId,
      bytes: bytes(),
      width: descriptor.width,
      height: descriptor.height,
    });
    mocks.applyImageToCanvas.mockResolvedValue({ ok: true, message: "done" });
  });

  it("refreshes and retries instead of charging the user a failure", async () => {
    mocks.requestCredentialRefresh.mockResolvedValue(FRESH);
    mocks.enhanceImage
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce({ success: true, msg: bytes(), updatedCredits: 861 });

    mount(DEAD);
    await press();

    expect(mocks.enhanceImage).toHaveBeenCalledTimes(2);
    expect(mocks.enhanceImage.mock.calls[0][1]).toBe(DEAD);
    expect(mocks.enhanceImage.mock.calls[1][1]).toBe(FRESH);
    expect(mocks.applyImageToCanvas).toHaveBeenCalledTimes(1);
    expect(notifications().filter((call) => call[0] === false)).toHaveLength(0);
  });

  it("re-reads the balance with the live credential, not the one it rendered with", async () => {
    mocks.requestCredentialRefresh.mockResolvedValue(FRESH);
    mocks.enhanceImage
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce({ success: true, msg: bytes(), updatedCredits: 861 });

    mount(DEAD);
    await press();

    expect(mocks.refreshBalance).toHaveBeenCalledWith(FRESH);
  });

  it("reports the expiry rather than looping when the session is really over", async () => {
    mocks.requestCredentialRefresh.mockResolvedValue(null);
    mocks.enhanceImage.mockResolvedValue(expired);

    mount(DEAD);
    await press();

    expect(mocks.enhanceImage).toHaveBeenCalledTimes(1);
    const failure = notifications().filter((call) => call[0] === false);
    expect(failure).toHaveLength(1);
    expect(failure[0][1]).toBe(expired.msg);
    expect(mocks.applyImageToCanvas).not.toHaveBeenCalled();
  });

  it("does not retry a rejected API key", async () => {
    mocks.requestCredentialRefresh.mockResolvedValue({ kind: "apikey", token: KEY });
    mocks.enhanceImage.mockResolvedValue({
      success: false,
      msg: "That API key was rejected.",
      retryable: false,
      tokenFailure: "wrong-key",
    });

    render(<Upscale gottenKey={KEY} isCreditsInsufficient={false} isOffline={false} />);
    await press();

    expect(mocks.enhanceImage).toHaveBeenCalledTimes(1);
    expect(mocks.requestCredentialRefresh).not.toHaveBeenCalled();
  });
});
