import { APP_NAME } from "@/shared/app-config";

/**
 * What a wallet signs to be linked to an account (/api/wallet/linked). Both
 * sides build it: the client has the wallet sign it, the server rebuilds it
 * from the request and its own host and checks the signature against that
 * copy, so no line of it comes from the client. Its wording is not the login
 * message's, so a login signature never links a wallet.
 *
 * The host line tells the signer where they are, but binds nothing: any site
 * can fetch a nonce and ask for this exact text. That is why a linked wallet
 * only ever shows its NFTs.
 */
export function linkWalletMessage({ domain, address, nonce }: { domain: string; address: string; nonce: string }): string {
  return [
    `${domain} asks you to link this wallet to your ${APP_NAME} account.`,
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    "",
    "Signing moves no funds and costs nothing.",
  ].join("\n");
}
