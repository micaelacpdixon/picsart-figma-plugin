// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TYPE_AUTH_RESPONSE,
  TYPE_CANCEL_SIGN_IN,
  SIGN_IN_DECLINED_ERR,
  SIGN_IN_TIMED_OUT_ERR,
} from "@constants/index";
import type { AuthState } from "@app-types/auth";

const mocks = vi.hoisted(() => ({ sendMessageToSandBox: vi.fn() }));
vi.mock("@api/index", () => ({ sendMessageToSandBox: mocks.sendMessageToSandBox }));

import SignIn from "../SignIn";
import AgentsSignIn from "../../Agents/AgentsSignIn";

const AWAITING: AuthState = {
  status: "awaiting",
  mode: "paste",
  authorizeUrl: "https://auth.picsart.com/api/oauth2/authorize?state=s1",
};

const props = (over: Partial<React.ComponentProps<typeof SignIn>> = {}) => ({
  authState: AWAITING as AuthState,
  showConfirmation: false,
  hasApiKey: false,
  hasCredential: false,
  balance: 10,
  balanceKnown: true,
  onDone: vi.fn(),
  onRetry: vi.fn(),
  onUseApiKey: vi.fn(),
  onAddCredits: vi.fn(),
  ...over,
});

let opened: ReturnType<typeof vi.fn>;

beforeEach(() => {
  opened = vi.fn();
  vi.stubGlobal("open", opened);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("opening the browser", () => {
  it("does not open a window on render — the click already did, in ui.tsx", () => {
    render(<SignIn {...props()} />);
    expect(opened).not.toHaveBeenCalled();
  });

  it("does not open one for an awaiting state it was merely re-told about", () => {
    const { rerender } = render(<SignIn {...props()} />);
    rerender(<SignIn {...props({ balance: 11 })} />);
    expect(opened).not.toHaveBeenCalled();
  });

  it("offers a manual re-open, because a blocked popup is indistinguishable from a closed tab", () => {
    render(<SignIn {...props()} />);

    fireEvent.click(screen.getByText("Open the sign-in page again"));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(
      AWAITING.status === "awaiting" ? AWAITING.authorizeUrl : "",
      "_blank",
      "noopener,noreferrer"
    );
  });
});

describe("the waiting screen", () => {
  it("has a Cancel, which is the only exit from the unobservable case", () => {
    render(<SignIn {...props()} />);

    fireEvent.click(screen.getByText("Cancel"));

    expect(mocks.sendMessageToSandBox).toHaveBeenCalledWith(true, "", TYPE_CANCEL_SIGN_IN);
  });

  it("submits the paste as raw text, without parsing it first", () => {
    render(<SignIn {...props()} />);

    fireEvent.change(screen.getByPlaceholderText("Paste the address or code"), {
      target: { value: "  http://localhost:8080/callback.html?code=ac%3Ax&state=s1  " },
    });
    fireEvent.click(screen.getByText("Submit"));

    expect(mocks.sendMessageToSandBox).toHaveBeenCalledWith(
      true,
      "http://localhost:8080/callback.html?code=ac%3Ax&state=s1",
      TYPE_AUTH_RESPONSE
    );
  });

  it("submits on Enter, which the control alone would not cover", () => {
    render(<SignIn {...props()} />);
    const input = screen.getByPlaceholderText("Paste the address or code");

    fireEvent.change(input, { target: { value: "ac:abc12345" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.sendMessageToSandBox).toHaveBeenCalledWith(
      true,
      "ac:abc12345",
      TYPE_AUTH_RESPONSE
    );
  });

  it("refuses an empty submit, and refuses a second one", () => {
    render(<SignIn {...props()} />);

    fireEvent.click(screen.getByText("Submit"));
    expect(
      mocks.sendMessageToSandBox.mock.calls.filter((call) => call[2] === TYPE_AUTH_RESPONSE)
    ).toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText("Paste the address or code"), {
      target: { value: "ac:abc12345" },
    });
    fireEvent.click(screen.getByText("Submit"));
    fireEvent.click(screen.getByText("Submit"));

    const submissions = mocks.sendMessageToSandBox.mock.calls.filter(
      (call) => call[2] === TYPE_AUTH_RESPONSE
    );
    expect(submissions).toHaveLength(1);
  });

  it("announces its transitions through one polite live region", () => {
    const { container } = render(<SignIn {...props()} />);
    const regions = container.querySelectorAll('[role="status"][aria-live="polite"]');
    expect(regions).toHaveLength(1);
  });

  it("does not use the full-scrim spinner, which would block its own controls", () => {
    const { container } = render(<SignIn {...props()} />);
    expect(container.querySelector(".loading-spinner")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("the failure screens", () => {
  it("names Picsart as the actor when the provider declined", () => {
    render(<SignIn {...props({ authState: { status: "denied" } })} />);
    expect(screen.getByText(SIGN_IN_DECLINED_ERR)).toBeTruthy();
  });

  it("shows the reason the sandbox resolved, never a raw wire string", () => {
    render(
      <SignIn {...props({ authState: { status: "failed", reason: SIGN_IN_TIMED_OUT_ERR } })} />
    );
    expect(screen.getByText(SIGN_IN_TIMED_OUT_ERR)).toBeTruthy();
  });

  it("offers the API key at the moment the first path failed", () => {
    const onUseApiKey = vi.fn();
    render(<SignIn {...props({ authState: { status: "denied" }, onUseApiKey })} />);

    fireEvent.click(screen.getByText("Use an API key instead"));
    expect(onUseApiKey).toHaveBeenCalled();
  });

  it("offers Continue only when there is something to continue with", () => {
    const { rerender } = render(
      <SignIn {...props({ authState: { status: "denied" }, hasCredential: false })} />
    );
    expect(screen.queryByText("Continue")).toBeNull();

    rerender(<SignIn {...props({ authState: { status: "denied" }, hasCredential: true })} />);
    expect(screen.getByText("Continue")).toBeTruthy();
  });
});

describe("the confirmation", () => {
  const signedIn: AuthState = {
    status: "signedIn",
    name: "Ada",
    scopes: ["workflows.execute"],
    expiresAt: Date.now() + 3_600_000,
  };

  it("names who is signed in and where the credits come from", () => {
    render(<SignIn {...props({ authState: signedIn, showConfirmation: true })} />);

    expect(screen.getByText("Signed in as Ada.")).toBeTruthy();
    expect(
      screen.getByText("Jobs are paid for from this account's credit balance.")
    ).toBeTruthy();
  });

  it("says a retained key exists, because signing out will switch the pool", () => {
    render(
      <SignIn {...props({ authState: signedIn, showConfirmation: true, hasApiKey: true })} />
    );
    expect(screen.getByText(/Signing out switches to it/)).toBeTruthy();
  });

  it("offers Add Credits instead of a dead end at zero credits", () => {
    const onAddCredits = vi.fn();
    render(
      <SignIn
        {...props({
          authState: signedIn,
          showConfirmation: true,
          balance: 0,
          balanceKnown: true,
          onAddCredits,
        })}
      />
    );

    expect(screen.getByText(/no credits left/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add Credits"));
    expect(onAddCredits).toHaveBeenCalled();
  });

  it("does not claim the account is empty before the balance has been read", () => {
    render(
      <SignIn
        {...props({
          authState: signedIn,
          showConfirmation: true,
          balance: 0,
          balanceKnown: false,
        })}
      />
    );

    expect(screen.queryByText(/no credits left/)).toBeNull();
    expect(screen.getByText("Signed in as Ada.")).toBeTruthy();
    expect(screen.queryByText("Add Credits")).toBeNull();
  });

  it("does not render at all when the flow did not complete here", () => {
    render(<SignIn {...props({ authState: signedIn, showConfirmation: false })} />);
    expect(screen.queryByText("Signed in as Ada.")).toBeNull();
  });
});


describe("Agents sign-in", () => {
  it.each([true, false])("continues to the Agents service without interpreting image-tool credits (known: %s)", balanceKnown => {
    const options = props({ authState: { status: "signedIn", scopes: [], expiresAt: Date.now() + 3600000 }, showConfirmation: true, balance: 0, balanceKnown });
    render(<AgentsSignIn {...options} />);
    expect(screen.queryByText(/no credits left/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Credits" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Agents" }));
    expect(options.onDone).toHaveBeenCalledOnce();
  });
});
