import { expect, type Page } from "@playwright/test";
import type { Address } from "viem";
import type { Manifest } from "../../packages/core/src/types.ts";

/** Browser wallet fixture backed by unlocked accounts on the local test RPC. */
export async function installWallet(
  page: Page,
  manifest: Manifest,
  account: Address,
) {
  await page.exposeFunction(
    "walletRpc",
    async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      const r = await fetch(manifest.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    },
  );
  await page.addInitScript((account) => {
    const listeners = new Map<string, Set<(value: any) => void>>();
    (window as any).testWalletAccount = account;
    (window as any).selectTestWalletAccount = (next: string) => {
      (window as any).testWalletAccount = next;
      for (const fn of listeners.get("accountsChanged") ?? []) fn([next]);
    };
    window.ethereum = {
      request: async ({ method, params }: any) =>
        method === "eth_requestAccounts" || method === "eth_accounts"
          ? [(window as any).testWalletAccount]
          : (window as any).walletRpc({ method, params }),
      on: (event: string, fn: (value: any) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener: (event: string, fn: (value: any) => void) =>
        listeners.get(event)?.delete(fn),
    };
  }, account);
}
export async function connectInjected(page: Page) {
  await page.getByRole("button", { name: "Demo account", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect browser wallet", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Connected wallet",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
