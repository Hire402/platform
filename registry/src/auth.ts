import { keccak256, recoverTypedDataAddress, toHex } from 'viem';
import { REGISTRY_TYPES, registryDomain } from '@hire402/sdk';

export type AuthResult =
  | { ok: true; address: string }
  | { ok: false; error: string; status: number };

/**
 * Verifies EIP-712 `RegistryRequest(bytes payload, uint64 ts, uint256 nonce)`
 * signatures (spec §10): the payload hash is keccak256 of the raw body, so
 * the registry must receive the body as a string (see content-type parser
 * in index.ts). Enforces ±300s clock skew and strict nonce monotonicity.
 */
export function makeAuth(chainId: bigint, nonces: Map<string, bigint>) {
  return async function verify(req: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<AuthResult> {
    const h = (k: string) => {
      const v = req.headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const sig = h('x-hire402-sig');
    const addr = h('x-hire402-addr');
    const ts = h('x-hire402-ts');
    const nonce = h('x-hire402-nonce');
    if (!sig || !addr || !ts || !nonce) {
      return { ok: false, error: 'missing X-Hire402-Sig/-Addr/-Ts/-Nonce headers', status: 401 };
    }
    if (typeof req.body !== 'string') {
      return { ok: false, error: 'raw string body required for signature verification', status: 400 };
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    let tsB: bigint;
    let nonceB: bigint;
    try {
      tsB = BigInt(ts);
      nonceB = BigInt(nonce);
    } catch {
      return { ok: false, error: 'ts/nonce must be integers', status: 400 };
    }
    const skew = now > tsB ? now - tsB : tsB - now;
    if (skew > 300n) return { ok: false, error: 'ts skew > 300s', status: 401 };

    const payload = keccak256(toHex(req.body));
    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        domain: registryDomain(chainId),
        types: REGISTRY_TYPES,
        primaryType: 'RegistryRequest',
        message: { payload, ts: tsB, nonce: nonceB },
        signature: sig as `0x${string}`,
      });
    } catch {
      return { ok: false, error: 'malformed signature', status: 401 };
    }
    if (recovered.toLowerCase() !== addr.toLowerCase()) {
      return { ok: false, error: 'signature does not match claimed address', status: 401 };
    }

    const key = addr.toLowerCase();
    const last = nonces.get(key) ?? 0n;
    if (nonceB <= last) return { ok: false, error: 'nonce replay', status: 401 };
    nonces.set(key, nonceB);

    return { ok: true, address: key };
  };
}
