import { AGENTS_BETA } from "@constants/agents";
import React, { useState } from "react";
import useOutsideClick from "@hooks/useOutsideClick";
import { TabType } from "@app-types/enums";
import { HELP_CENTER } from "@constants/url";
import "./styles.scss";
import { sendMessageToSandBox } from "@api/index";
import { TYPE_SWITCH_TAB } from "@constants/index";
import type { CredentialInput } from "@app-types/credential";

interface Props {
  gottenKey: CredentialInput;
  tab: TabType;
}

// Visual order, left to right. Generate Image leads: Figma now matches background
// removal and upscaling natively, so the capability it does not match at Picsart's
// model breadth is the one worth opening on.
//
// The label IS the enum value. There used to be three separate label constants in
// ui_constants/texts.ts whose only job was to restate these strings, and one of
// them had already drifted to a different capitalisation.
const TABS: readonly TabType[] = [
  TabType.GENERATE_IMAGE,
  TabType.REMOVE_BACKGROUND,
  TabType.UPSCALE,
];

const Navbar: React.FC<Props> = ({ gottenKey, tab }) => {
  const [showMenu, setShowMenu] = useState<boolean>(false);
  const ref = useOutsideClick<HTMLDivElement>(() => setShowMenu(false));

  const handleSelect = (option: TabType): void => {
    if (option === tab) return; // Don't switch if already on the same tab

    // The TAB_* constants are derived from TabType now, so the enum value IS the
    // constant. The getTabConstant switch that used to sit here was a hand-written
    // inverse of getTabUIValue in MessageListeners.ts, and keeping two mappers
    // mutually consistent by hand is what let the casing drift go unnoticed.
    sendMessageToSandBox(true, "Switching tab", TYPE_SWITCH_TAB, undefined, { tab: option });
  };

  const handleMenuClick = () => {
    setShowMenu((prev) => !prev);
  };

  const handleMenuItemClick = (option: TabType) => {
    setShowMenu(false);
    handleSelect(option);
  };

  return (
    <div className="navbar-container">
      {/* role="tablist" plus aria-selected, so a screen reader announces these as
          tabs and says which one is current. Three <span role="button"> elements
          reported nothing about being a set or about which was active. */}
      <div className="options-container" role="tablist" aria-label="Picsart tools">
        {TABS.map((type) => (
          <span
            key={type}
            className={`option ${tab === type ? "selected" : ""}`}
            onClick={() => handleSelect(type)}
            tabIndex={0}
            role="tab"
            aria-selected={tab === type}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSelect(type);
              }
            }}
          >
            {type}
          </span>
        ))}
      </div>
      <div 
        className="hamburger-menu" 
        onClick={handleMenuClick}
        tabIndex={0}
        role="button"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleMenuClick();
          }
        }}
      >
        <div className="hamburger-menu-icon">
          <svg
            width="14"
            height="12"
            viewBox="0 0 14 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M14 0H0V1H14V0Z" fill="#333333" />
            <path d="M0 5.5H14V6.5H0V5.5Z" fill="#333333" />
            <path d="M0 11H14V12H0V11Z" fill="#333333" />
          </svg>
        </div>
        {gottenKey && showMenu && (
          <div ref={ref} className="hamburger-menu-hidden-content">
            {AGENTS_BETA && <button onClick={() => handleMenuItemClick(TabType.AGENTS)}>AI Agents · beta</button>}
            <span 
              onClick={() => handleMenuItemClick(TabType.ACCOUNT)}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleMenuItemClick(TabType.ACCOUNT);
                }
              }}
            >
              Account Balance
            </span>
            <span 
              onClick={() => window.open(HELP_CENTER, "_blank")}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  window.open(HELP_CENTER, "_blank");
                }
              }}
            >
              Support
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default Navbar;
