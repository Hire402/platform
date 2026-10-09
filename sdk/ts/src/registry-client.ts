import { keccak256, toHex } from 'viem';
import type {
  Account,
  Chain,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem';
import { registryDomain, signRegistryRequest } from './eip712.js';

/**
 * EIP-712-authenticated client for the Hire402 Registry (spec §10).
 * Mutations are signed as RegistryRequest(keccak256(rawBody), ts, nonce).
 */
export class RegistryClient {
  constructor(
    public registryUrl: string,
    private walletClient: WalletClient<Transport, Chain, Account>,
    private publicClient: PublicClient<Transport, Chain>,
  ) {}

  get address(): `0x${string}` {
    if (!this.walletClient.account) throw new Error('wallet client has no account');
    return this.walletClient.account.address;
  }

  private async authHeaders(bodyStr: string): Promise<Record<string, string>> {
    const ts = BigInt(Math.floor(Date.now() / 1000));
    const nonce = BigInt(Date.now()); // ms — strictly increasing per address
    const payload = keccak256(toHex(bodyStr));
    const chainId = BigInt(await this.publicClient.getChainId());
    const sig = await signRegistryRequest(this.walletClient, registryDomain(chainId), {
      payload,
      ts,
      nonce,
    });
    return {
      'content-type': 'application/json',
      'x-hire402-sig': sig,
      'x-hire402-addr': this.address,
      'x-hire402-ts': ts.toString(),
      'x-hire402-nonce': nonce.toString(),
    };
  }

  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const bodyStr = JSON.stringify(body);
    const res = await fetch(`${this.registryUrl}${path}`, {
      method: 'POST',
      headers: await this.authHeaders(bodyStr),
      body: bodyStr,
    });
    if (!res.ok) {
      throw new Error(`registry POST ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.registryUrl}${path}`);
    if (!res.ok) {
      throw new Error(`registry GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
