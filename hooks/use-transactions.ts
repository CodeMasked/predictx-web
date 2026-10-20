"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MOCK_TRANSACTIONS,
  STORAGE_KEYS,
  type Transaction,
} from "@/lib/mock-data";

/**
 * Maximum number of transactions kept in persisted storage.
 *
 * New transactions are prepended; once the array exceeds this limit the oldest
 * entries (at the end) are evicted.  The cap prevents unbounded localStorage
 * growth while retaining a meaningful recent history.
 */
const MAX_TRANSACTIONS = 200;

interface TransactionsState {
  transactions: Transaction[];
  addTransaction: (tx: Omit<Transaction, "hash" | "ledger" | "fee">) => void;
}

function generateHash(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

export const useTransactions = create<TransactionsState>()(
  persist(
    (set) => ({
      transactions: MOCK_TRANSACTIONS,

      addTransaction: (tx) =>
        set((s) => ({
          transactions: [
            {
              ...tx,
              hash: generateHash(),
              ledger: 50_000_000 + Math.floor(Math.random() * 1_000_000),
              fee: "100 stroops (0.0000100 XLM)",
            },
            ...s.transactions,
          ].slice(0, MAX_TRANSACTIONS),
        })),
    }),
    {
      name: STORAGE_KEYS.transactions,
      /**
       * Only persist the transactions array — no derived or transient state
       * needs to be serialised.
       */
      partialize: (state) => ({ transactions: state.transactions }),
      /**
       * Wrap every setItem call so a QuotaExceededError degrades to
       * memory-only instead of propagating through the action and leaving the
       * in-memory state inconsistent with storage.
       */
      storage: {
        getItem: (name) => {
          const value = localStorage.getItem(name);
          return value ? JSON.parse(value) : null;
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch (err) {
            if (
              err instanceof DOMException &&
              (err.name === "QuotaExceededError" ||
                err.name === "NS_ERROR_DOM_QUOTA_REACHED")
            ) {
              // Storage is full — in-memory state is still correct, so swallow.
              if (process.env.NODE_ENV !== "production") {
                console.warn(
                  "[use-transactions] localStorage quota exceeded — transaction persisted in memory only.",
                );
              }
            } else {
              throw err;
            }
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
);
