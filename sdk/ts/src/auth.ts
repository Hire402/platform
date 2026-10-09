import { recoverTypedDataAddress } from 'viem';
import { REGISTRY_TYPES, registryDomain } from './eip712.js';

export interface RegistryAuthHeaders {
  sig: `0x${string}`;
  addr: `0x${string}`;
  ts: bigint;
  nonce: bigint;
}

/** Parses X-Hire402-* headers (fastify lowercases them). */
export function parseAuthHeaders(
  headers: Record<string, string | string[] | undefined>,
): RegistryAuthHeaders | null {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const sig = h('x-hire402-sig');
  const addr = h('x-hire402-addr');
  const ts = h('x-hire402-ts');
  const nonce = h('x-hire402-nonce');
  if (!sig || !addr || !ts || !nonce) return null;
  try {
    return {
      sig: sig as `0x${string}`,
      addr: addr as `0x${string}`,
      ts: BigInt(ts),
      nonce: BigInt(nonce),
    };
  } catch {
    return null;
  }
}

export type RegistryAuthResult =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Verifies an EIP-712 RegistryRequest over keccak256(rawBody) — shared by the
 * registry and the market. Callers track nonces (strict monotonicity) and
 * enforce clock skew (±300s) via `checkNonceAndSkew`.
 */
export async function verifyRegistryRequest(
  chainId: bigint,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<RegistryAuthResult> {
  const a = parseAuthHeaders(headers);
  if (!a) return { ok: false, error: 'missing X-Hire402-* headers' };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const skew = now > a.ts ? now - a.ts : a.ts - now;
  if (skew > 300n) return { ok: false, error: 'ts skew > 300s' };

  const { keccak256, toHex } = await import('viem');
  const payload = keccak256(toHex(rawBody));
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: registryDomain(chainId),
      types: REGISTRY_TYPES,
      primaryType: 'RegistryRequest',
      message: { payload, ts: a.ts, nonce: a.nonce },
      signature: a.sig,
    });
  } catch {
    return { ok: false, error: 'malformed signature' };
  }
  if (recovered.toLowerCase() !== a.addr.toLowerCase()) {
    return { ok: false, error: 'signature does not match claimed address' };
  }
  return { ok: true, address: a.addr.toLowerCase() };
}

/** Strict-nonce replay protection helper (returns false on replay). */
export function checkNonceAndSkew(
  nonces: Map<string, bigint>,
  addr: string,
  nonce: bigint,
): boolean {
  const last = nonces.get(addr) ?? 0n;
  if (nonce <= last) return false;
  nonces.set(addr, nonce);
  return true;
}
