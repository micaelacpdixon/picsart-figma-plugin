import { getBalance } from "@api/getBalance";
import { TYPE_GET_BALANCE } from "@constants/index";
import type { CredentialDescriptor } from "@app-types/credential";
import CustomSessionStorage from "./CustomSessionStorage";
import { credentialIdentity } from "./credentialIdentity";
import { postToUi } from "./UiBridge";

export const rememberBalance = (value: unknown, identity: string): boolean => {
  // Guarded before Number(): Number(null) and Number([]) are both 0, and Number("")
  // is 0 too, so a missing balance would otherwise cache as "out of credits" and
  // send the user to the pricing page with credits in their account.
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return false;
  }
  if (typeof value !== "number" && typeof value !== "string") return false;

  const credits = Number(value);
  if (!Number.isFinite(credits)) return false;

  CustomSessionStorage.getInstance().setBalance(credits, identity);
  return true;
};

const reads = new Map<string, Promise<void>>();

export const resetBalanceReads = () => reads.clear();

export const deliverBalance = (
  pluginApi: PluginAPI,
  credential: CredentialDescriptor | null | undefined
): Promise<void> => {
  const sessionStorage = CustomSessionStorage.getInstance();
  const identity = credentialIdentity(credential ?? undefined);

  if (!credential || sessionStorage.isWarmFor(identity)) {
    postToUi(pluginApi, {
      type: TYPE_GET_BALANCE,
      payload: sessionStorage.balanceFor(identity) ?? null,
    });
    return Promise.resolve();
  }

  const already = reads.get(identity);
  if (already) return already;

  const read = getBalance(credential)
    .then((result) => {
      const accepted = rememberBalance(result.success ? result.msg : undefined, identity);
      if (accepted) sessionStorage.markWarm(identity);
    })
    .catch((error) => console.error("Couldn't read the credit balance:", error))
    .then(() => {
      postToUi(pluginApi, {
        type: TYPE_GET_BALANCE,
        payload: sessionStorage.balanceFor(identity) ?? null,
      });
    })
    .finally(() => reads.delete(identity));

  reads.set(identity, read);
  return read;
};

export default rememberBalance;
