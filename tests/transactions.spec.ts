import { test, expect } from "@playwright/test";
import type {
  Snapshot,
  TransactionRecord,
} from "../packages/core/src/types.ts";
import { installWallet, connectInjected } from "./helpers/wallet.ts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { waitReceipt } from "../packages/core/src/receipts.ts";
import tokenAbi from "../packages/core/src/generated/OptionToken.json" with { type: "json" };

test("wallet partial failure retains the actual approval receipt through reload and journal outage", async ({
  page,
  request,
}) => {
  const checkpoint = await request.post("/api/demo/checkpoint", {
    data: { operation: "begin" },
  });
  expect(checkpoint.ok()).toBe(true);
  const checkpointId = (await checkpoint.json()).id;
  try {
    const s: Snapshot = await (await request.get("/api/snapshot")).json();
    const account = s.manifest.demoUser;
    const chain = defineChain({
      id: s.manifest.chainId,
      name: "Local",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [s.manifest.rpcUrl] } },
    });
    const client = createPublicClient({
      chain,
      transport: http(s.manifest.rpcUrl),
      pollingInterval: 100,
    });
    const wallet = createWalletClient({
      chain,
      account,
      transport: http(s.manifest.rpcUrl),
    });
    // Seeded development accounts have unlimited engine approval. Force an
    // actual prerequisite approval so this drill tests a partial action.
    await waitReceipt(
      client,
      await wallet.writeContract({
        address: s.manifest.wmon,
        abi: tokenAbi,
        functionName: "approve",
        args: [s.manifest.engine, 0n],
      }),
    );
    const before = await (
      await request.get(`/api/portfolio/${account}`)
    ).json();
    await installWallet(page, s.manifest, account);
    await page.goto("/write");
    await connectInjected(page);
    await page.evaluate((engine) => {
      const original = window.ethereum!.request.bind(window.ethereum);
      window.ethereum!.request = async (args: any) => {
        if (
          args.method === "eth_sendTransaction" &&
          args.params?.[0]?.to?.toLowerCase() === engine.toLowerCase()
        )
          throw Object.assign(new Error("User rejected fixture issuance"), {
            code: 4001,
          });
        return original(args);
      };
    }, s.manifest.engine);
    await page.getByLabel("Writer instrument").selectOption("15");
    await page.getByLabel("Writer quantity").fill("1");
    await page
      .getByRole("button", { name: "Review issuance", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Lock collateral & issue", exact: true })
      .click();
    await expect(page.locator(".toast[role=status]")).toContainText(
      "Some steps were submitted",
    );
    const approvalHash = await page.evaluate(
      ({ manifest, account }) => {
        const key = `strata-transactions:${manifest.chainId}:${manifest.engine.toLowerCase()}:${account.toLowerCase()}`;
        const records = JSON.parse(localStorage.getItem(key) ?? "[]");
        return records.find(
          (r: any) =>
            r.operation === "approve" &&
            r.target.toLowerCase() === manifest.wmon.toLowerCase(),
        )?.hash as string;
      },
      { manifest: s.manifest, account },
    );
    expect(approvalHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    await expect
      .poll(async () => {
        const records: TransactionRecord[] = await (
          await request.get(`/api/transactions/${account}`)
        ).json();
        return records.find(
          (r) =>
            r.hash === approvalHash &&
            r.target.toLowerCase() === s.manifest.wmon.toLowerCase() &&
            r.operation === "approve",
        )?.status;
      })
      .toBe("included");
    const records: TransactionRecord[] = await (
      await request.get(`/api/transactions/${account}`)
    ).json();
    const approval = records.find(
      (r) =>
        r.hash === approvalHash &&
        r.target.toLowerCase() === s.manifest.wmon.toLowerCase() &&
        r.operation === "approve",
    )!;
    const after = await (await request.get(`/api/portfolio/${account}`)).json();
    expect(after.positions).toEqual(before.positions);
    expect(after.usdc).toBe(before.usdc);
    expect(after.wmon).toBe(before.wmon);
    expect(
      (
        await request.post("/api/transactions", {
          data: { hash: approval.hash, account: s.manifest.maker },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.post("/api/transactions", {
          data: { hash: approval.hash, account, operation: "fake" },
        })
      ).status(),
    ).toBe(400);
    await page.goto("/portfolio");
    await page
      .getByRole("button", { name: "Transactions", exact: true })
      .click();
    const receiptRow = page.getByRole("row").filter({
      has: page.getByRole("button", {
        name: `Copy ${approval.hash}`,
        exact: true,
      }),
    });
    await expect(receiptRow).toContainText("Token approval");
    await expect(receiptRow).toContainText("included");
    await expect(receiptRow).toContainText("Chain checked");
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: new RegExp("^" + account.slice(0, 6), "i"),
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Transactions", exact: true })
      .click();
    await expect(receiptRow).toContainText("included");
    await page.route(`**/api/transactions/${account}`, (route) =>
      route.abort(),
    );
    await expect(page.locator(".transaction-note")).toContainText(
      "Chain verification is unavailable",
    );
    await expect(receiptRow).toBeVisible();
    await page.screenshot({ path: ".runtime/wallet-transactions-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".runtime/wallet-transactions-mobile.png",
      fullPage: true,
    });
    await page.unroute(`**/api/transactions/${account}`);
    await expect(page.locator(".transaction-note")).toContainText(
      "Included means a mined receipt",
    );
  } finally {
    const restored = await request.post("/api/demo/checkpoint", {
      data: { operation: "restore", id: checkpointId },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  }
});
