"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MATCHES,
  POLLS,
  PLATFORM_STATS,
  STORAGE_KEYS,
  type Match,
  type Poll,
  type PlatformStats,
} from "@/lib/mock-data";
import { trackEvent } from "@/lib/analytics";

interface MockDataState {
  matches: Match[];
  polls: Poll[];
  platformStats: PlatformStats;
  /** Number of polls created by the current user (incremented on each addPoll call). */
  userCreatedPollCount: number;
  getMatch: (id: string) => Match | undefined;
  getPolls: (matchId: string) => Poll[];
  getPoll: (pollId: string) => Poll | undefined;
  trendingPolls: () => Poll[];
  /**
   * Update pool amounts and track distinct staker wallets.
   *
   * @param pollId   - The poll to update.
   * @param side     - Which pool the stake goes into.
   * @param amount   - USD amount staked.
   * @param walletAddress - Wallet that placed the stake. When provided,
   *   `participants` reflects the number of *distinct* wallets, not
   *   the total number of stake transactions.
   */
  updatePollPool: (
    pollId: string,
    side: "yes" | "no",
    amount: number,
    walletAddress?: string,
  ) => void;
  addPoll: (poll: Poll) => void;
}

/**
 * Merge freshly-computed MATCHES timestamps into persisted state.
 *
 * MATCHES is evaluated at module-load time (every page load), so its `kickoff`
 * values are always relative to *now*.  Persisted state may have stale ISO
 * strings from a previous session.  We overwrite only the time-sensitive
 * `kickoff` and `status` fields while preserving any pool mutations the user
 * made in-session (e.g. `score` updates from live matches — those stay).
 */
function refreshMatchTimestamps(persisted: Match[]): Match[] {
  const freshById = new Map(MATCHES.map((m) => [m.id, m]));
  return persisted.map((m) => {
    const fresh = freshById.get(m.id);
    if (!fresh) return m;
    return { ...m, kickoff: fresh.kickoff, status: fresh.status };
  });
}

export const useMockData = create<MockDataState>()(
  persist(
    (set, get) => ({
      // Seed initial state from the always-fresh source constants.
      matches: MATCHES,
      polls: POLLS,
      platformStats: PLATFORM_STATS,
      userCreatedPollCount: 0,

      getMatch: (id) => get().matches.find((m) => m.id === id),

      getPolls: (matchId) => get().polls.filter((p) => p.matchId === matchId),

      getPoll: (pollId) => get().polls.find((p) => p.id === pollId),

      trendingPolls: () =>
        [...get().polls]
          .filter((p) => p.status === "active")
          .sort((a, b) => b.yesPool + b.noPool - (a.yesPool + a.noPool))
          .slice(0, 6),

      updatePollPool: (pollId, side, amount, walletAddress) =>
        set((s) => {
          const poll = s.polls.find((p) => p.id === pollId);

          // Dev warning: unknown poll id should never silently no-op
          if (!poll) {
            if (process.env.NODE_ENV !== "production") {
              console.warn(
                `[updatePollPool] Poll not found: "${pollId}". ` +
                  `Available IDs: ${s.polls.map((p) => p.id).join(", ")}`,
              );
            }
            return s; // no-op — leave state unchanged
          }

          return {
            polls: s.polls.map((p) => {
              if (p.id !== pollId) return p;

              // Build the updated stakers list (deduplicated)
              const currentStakers: string[] = Array.isArray(p.stakers)
                ? p.stakers
                : [];
              const updatedStakers =
                walletAddress && !currentStakers.includes(walletAddress)
                  ? [...currentStakers, walletAddress]
                  : currentStakers;

              // participants = number of distinct wallets
              // stakeCount   = total number of stake transactions
              return {
                ...p,
                yesPool: side === "yes" ? p.yesPool + amount : p.yesPool,
                noPool: side === "no" ? p.noPool + amount : p.noPool,
                stakeCount: (p.stakeCount ?? 0) + 1,
                stakers: updatedStakers,
                participants: walletAddress
                  ? updatedStakers.length
                  : p.participants + 1, // fallback: increment if no address given
              };
            }),
          };
        }),

      /** Prepend a newly-created poll so it appears immediately in all views. */
      addPoll: (poll) => {
        set((s) => ({
          polls: [poll, ...s.polls],
          userCreatedPollCount: s.userCreatedPollCount + 1,
        }));
        trackEvent({
          name: "poll_create",
          pollCategory: poll.category,
          matchId: poll.matchId,
        });
      },
    }),
    {
      name: STORAGE_KEYS.pools,
      /**
       * Partialize to mutable deltas only.
       *
       * `matches` and `polls` are seeded from compile-time constants (MATCHES /
       * POLLS) and refreshed on every rehydration via `onRehydrateStorage`.
       * Persisting the *entire* dataset on every `updatePollPool` call (which
       * may be triggered by every keystroke / stake) results in a synchronous
       * JSON.stringify of the full matches + polls payload for every write.
       *
       * Instead we persist only the mutable deltas:
       *   - `polls`             — pool amounts and staker lists change at runtime.
       *   - `userCreatedPollCount` — incremented by `addPoll`.
       *
       * `matches` and `platformStats` are never mutated at runtime, so they are
       * excluded.  They are always re-seeded from the source constants.
       */
      partialize: (state) => ({
        polls: state.polls,
        userCreatedPollCount: state.userCreatedPollCount,
      }),
      /**
       * Wrap setItem so a QuotaExceededError degrades gracefully.
       *
       * Without this guard the error escapes through the Zustand persist
       * middleware and surfaces inside the action that triggered it (e.g.
       * `updatePollPool`), at which point the in-memory state has already been
       * updated but the change was not persisted — the worst possible outcome.
       * We swallow the quota error and keep the in-memory update so the UI
       * continues to work correctly for the rest of the session.
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
              if (process.env.NODE_ENV !== "production") {
                console.warn(
                  "[use-mock-data] localStorage quota exceeded — pool update persisted in memory only.",
                );
              }
            } else {
              throw err;
            }
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
      /**
       * After zustand rehydrates from localStorage, fix up two classes of
       * staleness that a returning user would otherwise see:
       *
       *  1. Timestamps relative to "now" (MATCHES is recomputed on every page
       *     load) plus poll status, which is driven by match status.
       *  2. `participants`, which may be inflated relative to `stakers` from
       *     before the recompute fix was applied.
       *
       * Pool-size mutations the user accumulated in-session are preserved.
       */
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        // Refresh match kickoff/status fields from freshly-computed constants.
        state.matches = refreshMatchTimestamps(state.matches);

        const freshPollsById = new Map(POLLS.map((p) => [p.id, p]));

        state.polls = state.polls.map((poll) => {
          let next = poll;

          // Re-seed status from the source dataset so lock/voting progression
          // is correct. User-created polls (not in POLLS) are left as-is.
          const fresh = freshPollsById.get(poll.id);
          if (fresh && fresh.status !== poll.status) {
            next = { ...next, status: fresh.status };
          }

          // Recompute `participants` from `stakers`.
          if (!Array.isArray(next.stakers)) {
            next = { ...next, stakers: [], stakeCount: next.stakeCount ?? 0 };
          } else {
            const uniqueCount = new Set(next.stakers).size;
            if (uniqueCount > 0 && uniqueCount !== next.participants) {
              next = { ...next, participants: uniqueCount };
            }
          }

          return next;
        });
      },
    },
  ),
);
