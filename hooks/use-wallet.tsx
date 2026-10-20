"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { requestAccess, isConnected as checkFreighter } from "@stellar/freighter-api";
import {
  MOCK_CONTRACT_ID,
  STELLAR_BASE_FEE,
  XLM_USD_RATE,
} from "@/lib/constants";
import { formatAddress } from "@/lib/calculations";
import { STORAGE_KEYS } from "@/lib/mock-data";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import { stellar } from "@/lib/stellar";

export interface ConnectPayload {
  address: string;
  balance: number;
}

export interface TransactionReceipt {
  hash: string;
  ledger: number;
  fee: string;
  from: string;
  to: string;
  amount: number;
  amountXLM: number;
  timestamp: string;
}

export type StellarNetwork = "testnet" | "mainnet";

/** Discriminated status for balance lookups. */
export type BalanceStatus = "idle" | "loading" | "ok" | "error";

interface WalletState {
  isConnected: boolean;
  isConnecting: boolean;
  address: string;
  /** Last successfully fetched XLM balance. Never overwritten with 0 on a failed fetch. */
  balance: number;
  /** Indicates the result of the most-recent balance lookup. */
  balanceStatus: BalanceStatus;
  /**
   * Human-readable message when balanceStatus === "error".
   * e.g. "Account not found on mainnet — you may be on the wrong network."
   */
  balanceError: string | null;
  network: StellarNetwork;

  connect: () => Promise<void>;
  disconnect: () => void;
  updateBalance: (amount: number) => void;
  switchNetwork: (network: StellarNetwork) => void;
  /** Manually re-fetch the balance for the current address + network. */
  refreshBalance: () => Promise<void>;
  sendTransaction: (
    amountUSD: number,
    memo: string,
  ) => Promise<TransactionReceipt>;
}

/**
 * Fetch native XLM balance from Horizon.
 *
 * Returns a discriminated union so callers can distinguish a 404 (wrong
 * network / unfunded account) from a 5xx or a network failure. Horizon URLs
 * come from `lib/stellar` so there is a single source of truth.
 */
async function fetchBalance(
  publicKey: string,
  network: StellarNetwork,
): Promise<
  | { ok: true; balance: number }
  | { ok: false; status: number | null; message: string }
> {
  try {
    const response = await fetch(
      `${stellar.getHorizonUrl(network)}/accounts/${publicKey}`,
    );

    if (!response.ok) {
      if (response.status === 404) {
        return {
          ok: false,
          status: 404,
          message:
            network === "mainnet"
              ? "Account not found on Mainnet - you may be connected to Testnet."
              : "Account not found on Testnet - this account may not be funded.",
        };
      }
      return {
        ok: false,
        status: response.status,
        message: `Horizon returned ${response.status}. Try again shortly.`,
      };
    }

    const data = await response.json();
    const native = data.balances?.find(
      (b: { asset_type: string; balance?: string }) =>
        b.asset_type === "native",
    )?.balance;

    return { ok: true, balance: parseFloat(native ?? "0") };
  } catch {
    return {
      ok: false,
      status: null,
      message: "Network error - could not reach Horizon.",
    };
  }
}

/**
 * Per-address in-flight transaction latch.
 *
 * Deliberately outside the store: the guard has to be readable synchronously
 * from inside the transaction body, and it must survive the store being
 * replaced by a `persist` rehydrate mid-flight.
 *
 * Keyed by wallet address so that disconnecting one wallet (or switching
 * networks) does not leave a stale latch that blocks the next wallet's first
 * transaction.  The comment "one transaction at a time per wallet" is now
 * enforced at the data-structure level rather than relying on callers to clear
 * a single boolean.
 */
const transactionsInFlight = new Set<string>();

export const useWallet = create<WalletState>()(
  persist(
    (set, get) => ({
      isConnected: false,
      isConnecting: false,
      address: "",
      balance: 0,
      balanceStatus: "idle",
      balanceError: null,
      network: "testnet" as StellarNetwork,

      connect: async () => {
        set({ isConnecting: true });

        try {
          // 1. Check if installed
          const status = await checkFreighter();
          // Freighter v2 returns an object, v1 returned a boolean. This handles both!
          if (
            !status ||
            (typeof status === "object" && !status.isConnected)
          ) {
            toast.info(
              "Freighter is not installed. Please install the browser extension.",
            );
            return;
          }

          const accessResponse = await requestAccess();

          if ((accessResponse as any).error) {
            throw new Error((accessResponse as any).error);
          }

          const publicKey =
            typeof accessResponse === "string"
              ? accessResponse
              : (accessResponse as any).address;

          if (!publicKey) {
            throw new Error("Failed to retrieve public key");
          }

          set({ balanceStatus: "loading", balanceError: null });

          const currentNetwork = get().network;
          const result = await fetchBalance(publicKey, currentNetwork);

          if (result.ok) {
            set({
              isConnected: true,
              address: publicKey,
              balance: result.balance,
              balanceStatus: "ok",
              balanceError: null,
            });
          } else {
            set({
              isConnected: true,
              address: publicKey,
              balanceStatus: "error",
              balanceError: result.message,
            });
            toast.warning("Wallet connected, but balance is unavailable.", {
              description: result.message,
            });
          }

          // Analytics — no public key in the payload
          trackEvent({ name: "wallet_connect" });
        } catch (error) {
          console.error("Freighter connect error:", error);
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Could not connect to Freighter. Please try again.";
          toast.error("Connection failed", { description: message });
          throw error;
        } finally {
          set({ isConnecting: false });
        }
      },

      disconnect: () => {
        const { address } = get();

        // Clear user-scoped state so the next wallet starts from a clean slate
        // instead of inheriting the previous account's stakes, votes and unpaid
        // rewards. Imported lazily: both hooks depend on this module, so a
        // top-level import would be a cycle at module-evaluation time.
        if (address) {
          const { useStaking } = require("@/hooks/use-staking") as
            typeof import("@/hooks/use-staking");
          const { useVoting } = require("@/hooks/use-voting") as
            typeof import("@/hooks/use-voting");
          useStaking.getState().clearWalletStakes(address);
          useVoting.getState().clearWalletVotes(address);

          // Release the per-address transaction latch so that reconnecting
          // this (or any other) wallet is never blocked by a transaction that
          // was in flight at the moment of disconnect.
          transactionsInFlight.delete(address);
        }

        trackEvent({ name: "wallet_disconnect" });
        set({
          isConnected: false,
          address: "",
          balance: 0,
          isConnecting: false,
          balanceStatus: "idle",
          balanceError: null,
        });
      },

      switchNetwork: async (network: StellarNetwork) => {
        const { address, isConnected } = get();
        set({ network });

        // A network switch invalidates any in-flight transaction for this
        // address: the transaction was submitted against the old network and
        // its result is undefined on the new one.  Clear the latch so the
        // wallet is not permanently blocked after a mid-transaction switch.
        if (address) {
          transactionsInFlight.delete(address);
        }

        if (isConnected && address) {
          set({ balanceStatus: "loading", balanceError: null });

          const result = await fetchBalance(address, network);

          if (result.ok) {
            // Only update balance on success — never overwrite with 0 on error.
            set({
              balance: result.balance,
              balanceStatus: "ok",
              balanceError: null,
            });
          } else {
            // Keep the last-known balance; surface the error instead.
            set({
              balanceStatus: "error",
              balanceError: result.message,
            });
            toast.warning("Balance unavailable on this network.", {
              description: result.message,
              action:
                network === "mainnet"
                  ? {
                      label: "Switch to Testnet",
                      onClick: () => get().switchNetwork("testnet"),
                    }
                  : undefined,
            });
          }
        }

        toast.success(`Switched to ${network}`, {
          description:
            network === "mainnet"
              ? "You are now on Stellar Mainnet"
              : "You are now on Stellar Testnet",
        });
      },

      refreshBalance: async () => {
        const { address, isConnected, network } = get();
        if (!isConnected || !address) return;

        set({ balanceStatus: "loading", balanceError: null });

        const result = await fetchBalance(address, network);

        if (result.ok) {
          set({
            balance: result.balance,
            balanceStatus: "ok",
            balanceError: null,
          });
        } else {
          // Preserve last-known balance; surface error.
          set({
            balanceStatus: "error",
            balanceError: result.message,
          });
          toast.error("Balance lookup failed", {
            description: result.message,
            action:
              network === "mainnet"
                ? {
                    label: "Switch to Testnet",
                    onClick: () => get().switchNetwork("testnet"),
                  }
                : undefined,
          });
        }
      },

      updateBalance: (amount) =>
        set((state) => ({
          balance: state.balance + amount,
        })),

      /**
       * Simulates a Stellar transaction. Returns a mock receipt with
       * a realistic tx hash, ledger number, stroops fee, etc.
       * 95 % chance of success, 5 % simulated failure (network congestion).
       */
      sendTransaction: async (amountUSD, memo) => {
        const state = useWallet.getState();
        if (!state.isConnected || !state.address) {
          throw new Error("Wallet not connected");
        }

        /**
         * Re-entrancy latch (per-address).
         *
         * The simulated latency below is 1-2s, and the balance debit happens
         * *after* it. Without this latch, two overlapping calls both read the
         * same pre-await balance, both pass the sufficiency check, and both
         * then debit — driving the balance negative. The latch rejects the
         * second call outright rather than trying to reconcile it, because a
         * second concurrent transaction from one wallet is never legitimate
         * here: every call site debits as part of placing a single stake.
         *
         * Keyed by wallet address (not a single module-level boolean) so that
         * disconnecting one wallet and immediately connecting another does not
         * inherit the previous wallet's latch.
         */
        if (transactionsInFlight.has(state.address)) {
          throw new Error(
            "A transaction is already in progress. Please wait for it to finish.",
          );
        }
        transactionsInFlight.add(state.address);

        try {
          // Round to stroop precision (7 decimal places = 10^-7 XLM) to avoid
          // floating-point drift from repeated USD → XLM conversions.
          const STROOPS_PER_XLM = 10_000_000;
          const amountXLM =
            Math.round((amountUSD / XLM_USD_RATE) * STROOPS_PER_XLM) /
            STROOPS_PER_XLM;
          const feeXLM = STELLAR_BASE_FEE / STROOPS_PER_XLM; // 0.0000100 XLM

          if (amountXLM + feeXLM > state.balance) {
            throw new Error("Insufficient balance");
          }

          // simulate network latency (1-2 s)
          await new Promise((r) =>
            setTimeout(r, 1000 + Math.random() * 1000),
          );

        // 5 % failure rate
        if (Math.random() < 0.05) {
          const reasons = [
            "Network congestion — try again shortly",
            "Transaction timeout — Stellar Horizon did not respond",
          ];
          throw new Error(
            reasons[Math.floor(Math.random() * reasons.length)],
          );
        }

          // build mock receipt
          const hashBytes = Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 256)
              .toString(16)
              .padStart(2, "0"),
          ).join("");

        const receipt: TransactionReceipt = {
          hash: hashBytes,
          ledger: 50_000_000 + Math.floor(Math.random() * 1_000_000),
          fee: `${STELLAR_BASE_FEE} stroops (${feeXLM.toFixed(7)} XLM)`,
          from: state.address,
          to: MOCK_CONTRACT_ID,
          amount: amountUSD,
          amountXLM,
          timestamp: new Date().toISOString(),
        };

        /**
         * Re-check affordability against the live balance rather than the
         * snapshot taken before the await. With the latch above this is
         * belt-and-braces, but the debit is the authoritative moment: if
         * anything else moved the balance while this call was in flight, the
         * check that matters is the one here.
         */
        const liveBalance = useWallet.getState().balance;
        if (amountXLM + feeXLM > liveBalance) {
          throw new Error("Insufficient balance");
        }

        // Deduct both the transfer amount and the network fee so the ledger
        // balance exactly matches the receipt — fixes the drift described in #130.
        set((s) => ({ balance: s.balance - amountXLM - feeXLM }));

        return receipt;

          return receipt;
        } finally {
          transactionsInFlight.delete(state.address);
        }
      },
    }),
    {
      name: STORAGE_KEYS.wallet,
      // Don't persist transient status - always start fresh on page load.
      partialize: (state) => ({
        isConnected: state.isConnected,
        address: state.address,
        balance: state.balance,
        network: state.network,
      }),
    },
  )
);
