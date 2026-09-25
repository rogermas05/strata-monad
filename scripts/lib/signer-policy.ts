import { keccak256, type Address, type Hex } from "viem";
import type { SignerIntent } from "./managed-signer.ts";

/** One permitted contract call: exact target, exact function selectors, bounded native value. */
export interface CallPermission {
  target: Address;
  selectors: Hex[];
  maxValue?: bigint;
}

/**
 * Deployment- and role-specific signing policy. Anything not listed is refused,
 * so a compromised or buggy caller cannot use a role key for other contracts.
 */
export interface SignerPolicy {
  role: string;
  calls: CallPermission[];
  /** keccak256 of exact reviewed creation bytecode (including constructor arguments). */
  creations?: Hex[];
}

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function validatePolicy(policy: SignerPolicy): SignerPolicy {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(policy.role))
    throw new Error("Signer policy role must be a short lowercase identifier");
  for (const call of policy.calls) {
    if (!ADDRESS.test(call.target))
      throw new Error(`Invalid policy target for ${policy.role}`);
    if (
      !call.selectors.length ||
      !call.selectors.every((s) => SELECTOR.test(s))
    )
      throw new Error(`Policy for ${policy.role} needs exact 4-byte selectors`);
    if ((call.maxValue ?? 0n) < 0n)
      throw new Error(`Negative native value bound for ${policy.role}`);
  }
  for (const hash of policy.creations ?? [])
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
      throw new Error(`Invalid creation code hash for ${policy.role}`);
  return policy;
}

export function policyAuthorizer(policy: SignerPolicy) {
  const checked = validatePolicy(policy);
  return async (intent: SignerIntent): Promise<void> => {
    const value = intent.value ?? 0n;
    if (intent.to === undefined) {
      const hash = keccak256(intent.data);
      if (!(checked.creations ?? []).some((h) => h.toLowerCase() === hash))
        throw new Error(
          `${checked.role} is not authorized to deploy this bytecode`,
        );
      if (value !== 0n)
        throw new Error(`${checked.role} deployments may not transfer value`);
      return;
    }
    const target = intent.to.toLowerCase();
    const selector = intent.data.slice(0, 10).toLowerCase();
    const permission = checked.calls.find(
      (c) => c.target.toLowerCase() === target,
    );
    if (!permission)
      throw new Error(`${checked.role} is not authorized to call ${intent.to}`);
    if (
      intent.data.length < 10 ||
      !permission.selectors.some((s) => s.toLowerCase() === selector)
    )
      throw new Error(
        `${checked.role} is not authorized to call ${selector} on ${intent.to}`,
      );
    if (value > (permission.maxValue ?? 0n))
      throw new Error(`${checked.role} native value exceeds its policy bound`);
  };
}
