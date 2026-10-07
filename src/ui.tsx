import Agents from "./components/Agents/Agents";
import AgentsSignIn from "./components/Agents/AgentsSignIn";
import { AGENTS_BETA } from "@constants/agents";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BalanceProvider, useBalance } from "./context/BalanceContext";
import { ActiveProvider, useActive } from "./context/ActiveContext";
import { SelectionProvider } from "./context/SelectionContext";
import { CredentialProvider, useCredential } from "./context/CredentialContext";
import {
  Navbar,
  Account,
  BalanceBanner,
  IntroPage,
  RemoveBackground,
  RemoveBackgroundHidden,
  SignIn,
  Support,
  Upscale,
  GenerateImage,
  OfflineBanner,
  PANEL_FOOTER_ID,
} from "@components/index";
import useOffline from "@hooks/useOffline";
import { TabType } from "@app-types/enums";
import type { AuthState, CredentialMessage } from "@app-types/auth";
import {
  TYPE_ACTION,
  TYPE_AUTH_STATE,
  TYPE_CREDENTIAL,
  TYPE_GET_BALANCE,
  TYPE_EXCHANGE_REQUEST,
  TYPE_LOAD_EXCHANGE_PAGE,
  TYPE_RANDOM_RESULT,
  TYPE_REQUEST_RANDOM,
  TYPE_SWITCH_TAB,
  TYPE_TAB,
  TYPE_UI_READY,
  TYPE_VALIDATE_KEY,
} from "@constants/types";
import { PRICING } from "@constants/url";
import "@styles/global.scss";
import { getBalance, sendMessageToSandBox } from "./api";
import { requestSignIn } from "@utils/credentialBridge";
import { supplyRandomBytes } from "@utils/entropy";
import {
  forwardFromExchangePage,
  isExchangePageMessage,
  loadExchangePage,
  requestExchange,
} from "@utils/exchangeFrame";

export const isOwnFrame = (source: MessageEvent["source"]): boolean => {
  if (!source) return false;
  for (let i = 0; i < window.frames.length; i++) {
    if ((window.frames[i] as unknown) === (source as unknown)) return true;
  }
  return false;
};

// Exported for the layout-structure test. jsdom has no layout engine, so nothing
// here can assert a height — but which side of `.scrollable-content` an element
// sits on is plain DOM, and that is the half that regressed.
export const App = () => {
  const { setIsActive } = useActive()
  // Generate Image is the first tab across all four surfaces now: the manifest
  // menu, the navbar order, IntroController's landing tab for a keyless user, and
  // this initial state. A partial promotion reads as a bug rather than a decision.
  const [tab, setTab] = useState<TabType>(AGENTS_BETA ? TabType.AGENTS : TabType.GENERATE_IMAGE);
  const { setBalance, balance } = useBalance();
  const { credential, apiKey, setActive } = useCredential();
  const [authState, setAuthState] = useState<AuthState>({ status: "idle" });
  const [isCreditsInsufficient, setIsCreditsInsufficient] =
    useState<boolean>(false);
  const [balanceKnown, setBalanceKnown] = useState<boolean>(false);
  const isOffline = useOffline();

  const [initiated, setInitiated] = useState<boolean>(false);
  const openedRef = useRef<string | undefined>(undefined);
  const [justSignedIn, setJustSignedIn] = useState<boolean>(false);
  const previousStatus = useRef<AuthState["status"]>("idle");

  useEffect(() => {
    const wasInFlight =
      previousStatus.current === "starting" ||
      previousStatus.current === "awaiting" ||
      previousStatus.current === "working";

    if (wasInFlight && authState.status === "signedIn") setJustSignedIn(true);
    if (authState.status === "idle") setInitiated(false);

    previousStatus.current = authState.status;
  }, [authState]);

  const startSignIn = () => {
    setInitiated(true);
    const armed = authState.status === "armed" ? authState.authorizeUrl : undefined;
    if (armed) {
      openedRef.current = armed;
      window.open(armed, "_blank", "noopener,noreferrer");
    }
    requestSignIn();
  };

  useEffect(() => {
    if (!initiated) return;
    if (authState.status !== "awaiting") return;
    if (openedRef.current === authState.authorizeUrl) return;
    openedRef.current = authState.authorizeUrl;
    window.open(authState.authorizeUrl, "_blank", "noopener,noreferrer");
  }, [initiated, authState]);

  const leaveSignIn = (destination: TabType = tab) => {
    setJustSignedIn(false);
    setInitiated(false);
    sendMessageToSandBox(true, "", TYPE_SWITCH_TAB, undefined, { tab: destination });
  };

  const showConfirmation = justSignedIn && authState.status === "signedIn";
  const flowInFlight =
    authState.status === "starting" ||
    authState.status === "awaiting" ||
    authState.status === "working";
  const flowFailed = authState.status === "denied" || authState.status === "failed";
  const signInOwnsPanel = flowInFlight || flowFailed || showConfirmation;

  // Renders the current tab. This used to be a `page` state variable holding a
  // JSX element, rebuilt by a useEffect with seven dependencies — so every
  // selection change rebuilt the whole tree through state, and forgetting a
  // dependency meant a panel rendering with stale props. A plain function called
  // during render cannot go stale.
  const renderPage = () => {
    const active = credential!;
    switch (tab) {
      case TabType.AGENTS:
        return AGENTS_BETA ? <Agents onSignIn={startSignIn} /> : null;
      case TabType.TAB_REMOVE_BACKGROUND_INSTANTLY:
        return <RemoveBackgroundHidden gottenKey={active} />;
      case TabType.REMOVE_BACKGROUND:
        return (
          <RemoveBackground
            gottenKey={active}
            balanceKnown={balanceKnown}
            isCreditsInsufficient={isCreditsInsufficient}
            isOffline={isOffline}
          />
        );
      case TabType.UPSCALE:
        return (
          <Upscale
            gottenKey={active}
            balanceKnown={balanceKnown}
            isCreditsInsufficient={isCreditsInsufficient}
            isOffline={isOffline}
          />
        );
      case TabType.GENERATE_IMAGE:
        return (
          <GenerateImage
            gottenKey={active}
            balanceKnown={balanceKnown}
            isCreditsInsufficient={isCreditsInsufficient}
            isOffline={isOffline}
          />
        );
      case TabType.ACCOUNT:
        return (
          <Account
            setIsCreditsInsufficient={setIsCreditsInsufficient}
            credential={active}
            apiKey={apiKey}
            onSignIn={startSignIn}
            changeKey={(key) => {
              if (credential?.kind !== "oauth") setActive({ kind: "apikey", token: key }, key);
            }}
          />
        );
      case TabType.SUPPORT:
        return <Support />;
      default:
        return null;
    }
  };

  useEffect(() => {
    const messageHandler = async (event: MessageEvent) => {
      if (isExchangePageMessage(event.data)) {
        forwardFromExchangePage(event);
        return;
      }

      if (isOwnFrame(event.source)) return;

      const { pluginMessage } = event.data ?? {};
      if (!pluginMessage) return;
      const { type, payload } = pluginMessage;

      if (type === TYPE_CREDENTIAL) {
        if ((pluginMessage as CredentialMessage).requestId) return;
        const next = payload as CredentialMessage["payload"];
        setActive(next?.credential ?? null, next?.apiKey ?? "");
        setIsActive(() => true);
        setBalanceKnown(false);
        setIsCreditsInsufficient(false);
        sendMessageToSandBox(true, "", TYPE_GET_BALANCE);
      }
      else if (type === TYPE_REQUEST_RANDOM) {
        const { requestId, length } = pluginMessage;
        const { bytes, reason } = supplyRandomBytes(length);
        sendMessageToSandBox(true, "", TYPE_RANDOM_RESULT, undefined, {
          requestId,
          bytes,
          reason,
        });
      }
      else if (type === TYPE_LOAD_EXCHANGE_PAGE) {
        loadExchangePage(String(pluginMessage.url));
      }
      else if (type === TYPE_EXCHANGE_REQUEST) {
        requestExchange(pluginMessage.nonce, pluginMessage);
      }
      else if (type === TYPE_AUTH_STATE) {
        setAuthState(payload as AuthState);
        setIsActive(() => true);
      }
      else if (type === TYPE_VALIDATE_KEY) {
        const res = await getBalance(payload);
        if (res.success) {
          setIsActive(() => true);
          sendMessageToSandBox(true, "", TYPE_VALIDATE_KEY);
        } else {
          sendMessageToSandBox(false, "", TYPE_VALIDATE_KEY);
        }
      }
      else if (type === TYPE_ACTION) {
        // TYPE_ACTION was previously stored in an `action` state variable whose
        // only consumer was the page-rebuilding effect's dependency array. Nothing
        // read the value. Kept as an activity ping.
        setIsActive(() => true);
      } else if (type === TYPE_TAB) {
        setIsActive(() => true);
        setTab(payload);
      } else if (type === TYPE_GET_BALANCE) {
        setIsActive(() => true);
        const known = typeof payload === "number" && Number.isFinite(payload);
        if (known) setBalance(() => payload);
        setBalanceKnown(known);
        setIsCreditsInsufficient(known && payload <= 0);
      }
    };

    window.addEventListener("message", messageHandler);

    // Announced only after the listener is attached, which is the whole point: the
    // sandbox holds its messages until this arrives, so nothing can be posted into a
    // window that is not listening yet. Replaces the sandbox guessing 400ms.
    sendMessageToSandBox(true, "", TYPE_UI_READY);

    return () => {
      window.removeEventListener("message", messageHandler);
    };
  }, []);

  const SignInScreen = AGENTS_BETA && tab === TabType.AGENTS ? AgentsSignIn : SignIn;
  const signInScreen = (
    <SignInScreen
      authState={authState}
      showConfirmation={showConfirmation}
      hasApiKey={!!apiKey}
      hasCredential={!!credential}
      balance={balance}
      balanceKnown={balanceKnown}
      onDone={() => leaveSignIn()}
      onRetry={startSignIn}
      onUseApiKey={() => leaveSignIn(TabType.ACCOUNT)}
      onAddCredits={() => window.open(PRICING, "_blank")}
    />
  );

  return (
    <div className={`main-content ${tab === TabType.AGENTS ? "agents-panel" : ""}`}>
      {credential && tab !== TabType.AGENTS && <Navbar gottenKey={credential} tab={tab} />}
      <div className="scrollable-content">
        {signInOwnsPanel
          ? signInScreen
          : credential || (AGENTS_BETA && tab === TabType.AGENTS)
            ? renderPage()
            : <IntroPage onSignIn={startSignIn} />}
      </div>
      {/* The primary action's home, OUTSIDE the scroller and above the credits strip.
          Each tab portals its own button in here through PanelFooter, so the button
          keeps the per-tab state that decides its label and whether it is enabled,
          while its position stops depending on how tall the panel's content is. A
          `flex-shrink: 0` inside `.scrollable-content` pinned nothing. */}
      {credential && !signInOwnsPanel && <div id={PANEL_FOOTER_ID} className="panel-footer" />}
      {isOffline && (
        <div className="bottom-banner">
          <OfflineBanner />
        </div>
      )}
      {credential && !signInOwnsPanel && (
        <div className="bottom-banner">
          {(tab === TabType.REMOVE_BACKGROUND || tab === TabType.UPSCALE || tab === TabType.GENERATE_IMAGE) && (
            <BalanceBanner
              balanceKnown={balanceKnown}
              gottenKey={credential}
              isCreditsInsufficient={isCreditsInsufficient}
              setIsCreditsInsufficient={setIsCreditsInsufficient}
            />
          )}
        </div>
      )}
    </div>
  );
};

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <ActiveProvider>
      <BalanceProvider>
        <CredentialProvider>
          <SelectionProvider>
            <App />
          </SelectionProvider>
        </CredentialProvider>
      </BalanceProvider>
    </ActiveProvider>
  );
}
