/**
 * ThreadTitleAutoRefreshReactor - keeps automatic thread titles current (fork feature).
 *
 * As a thread grows it asks the existing title regeneration flow whether the
 * title still fits. The regeneration prompt keeps the title unless the subject
 * changed, so most checks rename nothing. A thread whose latest title came
 * from the user (a manual rename) is never touched.
 *
 * @module ThreadTitleAutoRefreshReactor
 */
import { CommandId, type MessageId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class ThreadTitleAutoRefreshReactor extends Context.Service<
  ThreadTitleAutoRefreshReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadTitleAutoRefreshReactor") {}

// Thread growth is measured in user turns: consecutive user messages with no
// assistant reply between them are one turn, and a long turn counts as
// several (one per CHARS_PER_TURN characters).
const CHARS_PER_TURN = 1_000;
// A turn that grows past this is checked right away, whatever the schedule.
const LARGE_TURN_CHARS = 2_000;
// Check often while the thread is young, then back off: long threads rarely
// change subject, and each check is one text-generation call.
const EARLY_CHECKPOINTS = [2, 4, 6, 9, 12, 15, 20, 25, 30];
const LATE_CHECKPOINT_INTERVAL = 20;

export interface TitleCheckMessage {
  readonly messageId: string;
  readonly role: string;
  /** Trimmed text length; 0 for attachment-only messages. */
  readonly chars: number;
  /** A bare /compact, which is a command rather than conversation. */
  readonly isCompact: boolean;
}

const turnWeight = (chars: number) => Math.max(1, chars / CHARS_PER_TURN);

/** @internal Exported for tests. */
export function crossesCheckpoint(before: number, after: number): boolean {
  if (after <= before) {
    return false;
  }
  if (EARLY_CHECKPOINTS.some((checkpoint) => before < checkpoint && checkpoint <= after)) {
    return true;
  }
  const lastEarly = EARLY_CHECKPOINTS[EARLY_CHECKPOINTS.length - 1] ?? 0;
  const lateSteps = Math.floor((after - lastEarly) / LATE_CHECKPOINT_INTERVAL);
  return lateSteps >= 1 && lastEarly + lateSteps * LATE_CHECKPOINT_INTERVAL > before;
}

/**
 * Whether the user message that just started a turn should trigger a title
 * check. `messages` is the whole thread in display order.
 *
 * @internal Exported for tests.
 */
export function isTitleCheckDue(
  messages: ReadonlyArray<TitleCheckMessage>,
  messageId: string,
): boolean {
  let closedWeight = 0;
  // Characters of the open user turn; null once an assistant reply closes it.
  let openTurnChars: number | null = null;
  let turnCount = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      if (openTurnChars !== null) {
        closedWeight += turnWeight(openTurnChars);
        openTurnChars = null;
      }
      continue;
    }
    if (message.role !== "user" || message.isCompact) {
      if (message.messageId === messageId) {
        return false;
      }
      continue;
    }

    const charsBefore: number = openTurnChars ?? 0;
    const weightBefore = closedWeight + (openTurnChars === null ? 0 : turnWeight(charsBefore));
    if (openTurnChars === null) {
      turnCount += 1;
    }
    const turnChars = charsBefore + message.chars;
    openTurnChars = turnChars;
    if (message.messageId !== messageId) {
      continue;
    }
    // The first turn already gets a title from first-turn generation.
    if (turnCount <= 1) {
      return false;
    }
    const weightAfter = closedWeight + turnWeight(turnChars);
    return (
      crossesCheckpoint(weightBefore, weightAfter) ||
      (charsBefore < LARGE_TURN_CHARS && turnChars >= LARGE_TURN_CHARS)
    );
  }
  return false;
}

// Command id prefixes of the server's own title writes: the first-turn title
// and a completed regeneration (see ProviderCommandReactor). Any other title
// write, such as a rename from a client, marks the title as user-owned.
const AUTOMATIC_TITLE_COMMAND_PREFIXES = [
  "server:thread-title-rename:",
  "server:thread-title-regeneration-complete:",
];

/** @internal Exported for tests. */
export function isAutomaticTitleCommand(commandId: string | null): boolean {
  return (
    commandId !== null &&
    AUTOMATIC_TITLE_COMMAND_PREFIXES.some((prefix) => commandId.startsWith(prefix))
  );
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // A queued turn can publish its start more than once; check each message once.
  const lastCheckedMessageByThread = new Map<ThreadId, MessageId>();

  const listTitleCheckMessages = (threadId: ThreadId) =>
    sql<{
      readonly messageId: string;
      readonly role: string;
      readonly chars: number;
      readonly isCompact: number;
    }>`
      SELECT
        message_id AS "messageId",
        role,
        LENGTH(TRIM(text, char(9, 10, 11, 12, 13, 32))) AS "chars",
        (
          LOWER(TRIM(text, char(9, 10, 11, 12, 13, 32))) = '/compact'
          AND COALESCE(json_array_length(attachments_json), 0) = 0
        ) AS "isCompact"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, message_id ASC
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): TitleCheckMessage => ({ ...row, isCompact: row.isCompact === 1 })),
      ),
    );

  const latestTitleCommandId = (threadId: ThreadId) =>
    sql<{ readonly commandId: string | null }>`
      SELECT command_id AS "commandId"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'thread.meta-updated'
        AND json_extract(payload_json, '$.title') IS NOT NULL
      ORDER BY sequence DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const processTurnStart = Effect.fn("ThreadTitleAutoRefreshReactor.processTurnStart")(
    function* (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) {
      const { threadId, messageId } = input;
      if (lastCheckedMessageByThread.get(threadId) === messageId) {
        return;
      }
      lastCheckedMessageByThread.set(threadId, messageId);
      if (!isTitleCheckDue(yield* listTitleCheckMessages(threadId), messageId)) {
        return;
      }

      const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
      if (!thread || thread.archivedAt !== null || thread.titleRegeneration != null) {
        return;
      }
      // No title write yet means the title is still the creation default or seed.
      const latest = yield* latestTitleCommandId(threadId);
      if (Option.isSome(latest) && !isAutomaticTitleCommand(latest.value.commandId)) {
        return;
      }

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:thread-title-auto-refresh:${yield* crypto.randomUUIDv4}`),
        threadId,
        regenerateTitle: true,
      });
    },
  );

  const processTurnStartSafely = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) =>
    processTurnStart(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread title auto-refresh failed", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processTurnStartSafely);

  const start: ThreadTitleAutoRefreshReactor["Service"]["start"] = Effect.fn(
    "ThreadTitleAutoRefreshReactor.start",
  )(function* () {
    const domainEvents = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(domainEvents, (event) =>
        event.type === "thread.turn-start-requested"
          ? worker.enqueue({
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
            })
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadTitleAutoRefreshReactor["Service"];
});

export const layer = Layer.effect(ThreadTitleAutoRefreshReactor, make);
