import React, { useEffect } from "react";
import { sendMessageToSandBox } from "@api/index";
import { BtnType } from "@app-types/enums";
import { Button } from "@components/index";
import useBalanceRecovery from "@hooks/useBalanceRecovery";
import type { CredentialInput } from "@app-types/credential";
import { asCredential } from "@api/customFetch";
import { balanceModeLabel } from "@ui_constants/texts";
import { useBalance } from "../../context/BalanceContext";
import { TYPE_GET_BALANCE } from "@constants/types";
import "./styles.scss";

interface Props {
  gottenKey: CredentialInput;
  isCreditsInsufficient: boolean;
  balanceKnown?: boolean;
  setIsCreditsInsufficient: (status: boolean) => void;
}

const BalanceBanner: React.FC<Props> = ({
  gottenKey,
  isCreditsInsufficient,
  balanceKnown = true,
  setIsCreditsInsufficient,
}) => {
  const { balance } = useBalance();
  const { openPricing } = useBalanceRecovery(gottenKey, isCreditsInsufficient);

  const mode = asCredential(gottenKey).kind;

  useEffect(() => {
    sendMessageToSandBox(true, "", TYPE_GET_BALANCE);
    setIsCreditsInsufficient(balanceKnown && balance <= 0);
  }, [ asCredential(gottenKey).token ]);

  return (
    // <div className={`balance-container ${isCreditsInsufficient ? 'full-width' : ''}`}>
    <div className={"balance-container"}>
      <div className="text-container">
        <span className="balance-text">{balanceModeLabel(mode)}</span>
        <span className="credits-text">{balanceKnown ? `${balance} credits` : "Balance unavailable"}</span>
      </div>
      {!balanceKnown ? <button className="balance-retry" onClick={() => sendMessageToSandBox(true, "", TYPE_GET_BALANCE)}>Retry</button> : isCreditsInsufficient ? (
        <div style={{ width: 120, height: 30 }}>
          <Button
            type={BtnType.ADD_CREDITS}
            cb={openPricing}
            tabIndex={0}
          />
        </div>
      ) : (
        <div
          className="plus-container"
          onClick={openPricing}
          tabIndex={0}
          role="button"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPricing();
            }
          }}
          title="Add more credits"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M5.5 5.5V0.5H6.5V5.5H11.5V6.5H6.5V11.5H5.5V6.5H0.5V5.5H5.5Z"
              fill="#520BE5"
            />
          </svg>
        </div>
      )}
    </div>
  );
};

export default BalanceBanner;
