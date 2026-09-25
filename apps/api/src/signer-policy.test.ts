import { describe, expect, test } from "vitest";
import { keccak256, toFunctionSelector, type Hex } from "viem";
import {
  policyAuthorizer,
  validatePolicy,
} from "../../../scripts/lib/signer-policy.ts";

const engine = "0x9d136eea063ede5418a6bc7beaff009bbb6cfa70";
const other = "0x1111111111111111111111111111111111111111";
const write = toFunctionSelector("write(uint256,uint256,address)");
const approve = toFunctionSelector("approve(address,uint256)");
const initCode: Hex = "0x6007600c60003960076000f360003560005500";

describe("signer policy", () => {
  const authorize = policyAuthorizer({
    role: "maker",
    calls: [{ target: engine, selectors: [write] }],
    creations: [keccak256(initCode)],
  });

  test("allows an exact target and selector with no value", async () => {
    await expect(
      authorize({ id: "a", to: engine, data: `${write}00` }),
    ).resolves.toBeUndefined();
  });

  test("refuses unlisted targets, selectors and native value", async () => {
    await expect(
      authorize({ id: "b", to: other, data: write }),
    ).rejects.toThrow("not authorized to call");
    await expect(
      authorize({ id: "c", to: engine, data: approve }),
    ).rejects.toThrow(`not authorized to call ${approve}`);
    await expect(
      authorize({ id: "d", to: engine, data: write, value: 1n }),
    ).rejects.toThrow("native value exceeds");
    await expect(
      authorize({ id: "e", to: engine, data: "0x" }),
    ).rejects.toThrow("not authorized to call");
  });

  test("allows only reviewed creation bytecode", async () => {
    await expect(
      authorize({ id: "f", data: initCode }),
    ).resolves.toBeUndefined();
    await expect(authorize({ id: "g", data: `${initCode}00` })).rejects.toThrow(
      "not authorized to deploy",
    );
  });

  test("rejects malformed policies before any signing", () => {
    expect(() => validatePolicy({ role: "Maker!", calls: [] })).toThrow(
      "short lowercase identifier",
    );
    expect(() =>
      validatePolicy({
        role: "maker",
        calls: [{ target: engine, selectors: [] }],
      }),
    ).toThrow("exact 4-byte selectors");
    expect(() =>
      validatePolicy({
        role: "maker",
        calls: [{ target: "0x12", selectors: [write] }],
      }),
    ).toThrow("Invalid policy target");
  });
});
