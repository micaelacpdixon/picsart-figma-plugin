// @vitest-environment jsdom
//
// The panel's pinned chrome, asserted as DOM structure.
//
// `.scrollable-content` is `overflow-y: auto`, so anything rendered inside it
// scrolls away when the content is taller than the window — and Figma clamps the
// window to the screen, so on a short display that is every panel. Two elements
// must never be in there: the tab row, because a user who scrolls to reach a
// control should not lose the way back to another tab, and the footer host,
// because it holds the one button the panel exists for.
//
// The footer was moved out once already (a `flex-shrink: 0` inside an
// `overflow-y: auto` box pins nothing) and the navbar was left behind, where it
// did something worse than scroll: as a flex item with the default
// `flex-shrink: 1` it compressed from 32px to 14px first, silently absorbing the
// first 18px of every overflow, so a panel that was already too short showed no
// symptom until it was 18px past too short.
//
// Heights themselves are not testable here — jsdom computes no layout. They are
// measured by loading dist/ui.html in headless Chromium; see the note in
// constants/env.ts.
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPE_AUTH_STATE, TYPE_CREDENTIAL, TYPE_VALIDATE_KEY, TYPE_GET_BALANCE } from "@constants/types";

const mocks = vi.hoisted(() => ({
  sendMessageToSandBox: vi.fn(),
  getBalance: vi.fn(
    async (): Promise<{ success: boolean; msg: number | string }> => ({
      success: true,
      msg: 100,
    })
  ),
}));

vi.mock("@api/index", () => ({
  sendMessageToSandBox: mocks.sendMessageToSandBox,
  getBalance: mocks.getBalance,
}));
// ui.tsx imports these from "./api" rather than the alias.
vi.mock("../api", () => ({
  sendMessageToSandBox: mocks.sendMessageToSandBox,
  getBalance: mocks.getBalance,
}));

vi.mock("@hooks/useOffline", () => ({ default: () => false }));

// Stand-ins for the tab bodies: this test is about where ui.tsx puts the panel
// chrome, not about what any one tab renders. PANEL_FOOTER_ID stays the real
// value so the id ui.tsx renders is the id PanelFooter portals into.
vi.mock("@components/index", () => ({
  PANEL_FOOTER_ID: "panel-footer",
  Navbar: () => <div data-testid="navbar" className="navbar-container" />,
  Account: () => <div />,
  BalanceBanner: ({ balanceKnown, isCreditsInsufficient }: { balanceKnown: boolean; isCreditsInsufficient: boolean }) => <div data-testid="balance-banner" data-known={balanceKnown} data-insufficient={isCreditsInsufficient} />,
  ChangeAPIkey: () => <div />,
  IntroPage: ({ onSignIn }: { onSignIn?: () => void }) => (
    <div data-testid="intro">
      <button data-testid="signin-cta" onClick={onSignIn} />
    </div>
  ),
  RemoveBackground: () => <div />,
  RemoveBackgroundHidden: () => <div />,
  Support: () => <div />,
  Upscale: () => <div />,
  GenerateImage: () => <div data-testid="tab-body" />,
  OfflineBanner: () => <div />,
  SignIn: () => <div data-testid="signin" />,
}));

import { App } from "../ui";
import { CredentialProvider } from "../context/CredentialContext";

const renderApp = () =>
  render(
    <CredentialProvider>
      <App />
    </CredentialProvider>
  );

const fromSandbox = (pluginMessage: unknown): MessageEvent =>
  new MessageEvent("message", { data: { pluginMessage } });

const authenticate = () =>
  act(() => {
    window.dispatchEvent(
      fromSandbox({
        type: TYPE_CREDENTIAL,
        payload: {
          credential: { kind: "apikey", token: "test-key" },
          apiKey: "test-key",
        },
      })
    );
  });

const requestValidation = async () => {
  await act(async () => {
    window.dispatchEvent(
      fromSandbox({
        type: TYPE_VALIDATE_KEY,
        payload: { kind: "apikey", token: "test-key" },
      })
    );
  });
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("panel chrome placement", () => {
  it("keeps the tab row out of the scroller", () => {
    const { container } = renderApp();
    authenticate();

    const scroller = container.querySelector(".scrollable-content");
    const navbar = container.querySelector('[data-testid="navbar"]');

    expect(scroller).not.toBeNull();
    expect(navbar).not.toBeNull();
    // The assertion that fails on the regression: the navbar rendered as a child
    // of the scroller, so it scrolled out of view and squashed under pressure.
    expect(scroller!.contains(navbar!)).toBe(false);
  });

  it("keeps the footer host out of the scroller", () => {
    const { container } = renderApp();
    authenticate();

    const scroller = container.querySelector(".scrollable-content");
    const footer = container.querySelector("#panel-footer");

    expect(footer).not.toBeNull();
    expect(scroller!.contains(footer!)).toBe(false);
  });

  it("orders the chrome tabs, then scroller, then footer, then credits", () => {
    const { container } = renderApp();
    authenticate();

    const main = container.querySelector(".main-content")!;
    const order = Array.from(main.children).map((el) =>
      el.classList.contains("navbar-container")
        ? "navbar"
        : el.classList.contains("scrollable-content")
          ? "scroller"
          : el.id === "panel-footer"
            ? "footer"
            : el.classList.contains("bottom-banner")
              ? "credits"
              : "other"
    );

    // The credits strip is context for the spend and the button is the spend, so
    // the button stays the last thing before it.
    expect(order).toEqual(["navbar", "scroller", "footer", "credits"]);
  });

  it("renders no chrome around the intro page when there is no key", () => {
    const { container } = renderApp();

    // A keyless user has no tabs to switch between and no action to pin, so the
    // panel is the intro page and nothing else.
    expect(container.querySelector('[data-testid="navbar"]')).toBeNull();
    expect(container.querySelector("#panel-footer")).toBeNull();
    expect(container.querySelector('[data-testid="intro"]')).not.toBeNull();
  });
});

describe("credential validation replies", () => {
  it("accepts a valid credential holding exactly zero credits", async () => {
    mocks.getBalance.mockResolvedValueOnce({ success: true, msg: 0 });
    renderApp();

    await requestValidation();

    expect(mocks.sendMessageToSandBox).toHaveBeenCalledWith(
      true,
      "",
      TYPE_VALIDATE_KEY
    );
  });

  it("rejects a credential the balance call refused", async () => {
    mocks.getBalance.mockResolvedValueOnce({
      success: false,
      msg: "API key is wrong",
    });
    renderApp();

    await requestValidation();

    expect(mocks.sendMessageToSandBox).toHaveBeenCalledWith(
      false,
      "",
      TYPE_VALIDATE_KEY
    );
  });

  it("opens the browser INSIDE the click, from the armed URL", () => {
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const armedUrl = "https://auth.picsart.com/api/oauth2/authorize?state=armed-1";
    try {
      renderApp();
      act(() => {
        window.dispatchEvent(
          fromSandbox({ type: TYPE_AUTH_STATE, payload: { status: "armed", authorizeUrl: armedUrl } })
        );
      });

      fireEvent.click(screen.getByTestId("signin-cta"));

      expect(opened).toHaveBeenCalledWith(armedUrl, "_blank", "noopener,noreferrer");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not open a window for an awaiting state it was merely re-told about", () => {
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    try {
      renderApp();
      act(() => {
        window.dispatchEvent(
          fromSandbox({
            type: TYPE_AUTH_STATE,
            payload: {
              status: "awaiting",
              mode: "paste",
              authorizeUrl: "https://auth.picsart.com/api/oauth2/authorize?state=retold",
            },
          })
        );
      });

      expect(opened).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores a pluginMessage posted by one of its own child frames", async () => {
    renderApp();
    mocks.sendMessageToSandBox.mockClear();

    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    expect(window.frames.length).toBeGreaterThan(0);

    try {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              pluginMessage: {
                type: TYPE_CREDENTIAL,
                payload: {
                  credential: { kind: "apikey", token: "injected-by-the-iframe" },
                  apiKey: "injected-by-the-iframe",
                },
              },
            },
            source: frame.contentWindow,
          })
        );
      });

      expect(mocks.getBalance).not.toHaveBeenCalled();
      expect(mocks.sendMessageToSandBox).not.toHaveBeenCalled();
    } finally {
      frame.remove();
    }
  });

  it("accepts a sandbox message whose source is not window.parent", async () => {
    renderApp();

    expect(screen.queryByTestId("navbar")).toBeNull();
    expect(screen.queryByTestId("tab-body")).toBeNull();

    authenticate();

    expect(screen.getByTestId("navbar")).toBeTruthy();
    expect(screen.getByTestId("tab-body")).toBeTruthy();
  });
});


describe("balance availability", () => {
  it("distinguishes an unavailable balance from a confirmed zero and clears it on account change", () => {
    renderApp(); authenticate();
    const reply = (payload: unknown) => act(() => { window.dispatchEvent(fromSandbox({ type: TYPE_GET_BALANCE, payload })); });
    reply(null);
    expect(screen.getByTestId("balance-banner").dataset).toMatchObject({ known: "false", insufficient: "false" });
    reply(0);
    expect(screen.getByTestId("balance-banner").dataset).toMatchObject({ known: "true", insufficient: "true" });
    authenticate();
    expect(screen.getByTestId("balance-banner").dataset).toMatchObject({ known: "false", insufficient: "false" });
    reply(25);
    expect(screen.getByTestId("balance-banner").dataset).toMatchObject({ known: "true", insufficient: "false" });
  });
});
