import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ThreadId,
  ThreadMetaUpdatedPayload,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutomaticTitleCommand,
  isTitleCheckDue,
  layer as ThreadTitleAutoRefreshReactorLayer,
  type TitleCheckMessage,
  ThreadTitleAutoRefreshReactor,
} from "./ThreadTitleAutoRefreshReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const encodeMetaUpdatedPayload = Schema.encodeSync(Schema.fromJsonString(ThreadMetaUpdatedPayload));

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const user = (messageId: string, chars = 100): TitleCheckMessage => ({
  messageId,
  role: "user",
  chars,
  isCompact: false,
});
const assistant = (messageId: string): TitleCheckMessage => ({
  messageId,
  role: "assistant",
  chars: 500,
  isCompact: false,
});

/** Turns whose user message would trigger a check, for a plain back-and-forth. */
const dueTurns = (turnChars: ReadonlyArray<number>): Array<number> => {
  const messages = turnChars.flatMap((chars, index) => [
    user(`u${index + 1}`, chars),
    assistant(`a${index + 1}`),
  ]);
  return turnChars
    .map((_, index) => index + 1)
    .filter((turn) => isTitleCheckDue(messages, `u${turn}`));
};

describe("isTitleCheckDue", () => {
  it("checks every 2-3 turns early, then every 5, then every 20", () => {
    assert.deepStrictEqual(
      dueTurns(Array.from({ length: 95 }, () => 100)),
      [2, 4, 6, 9, 12, 15, 20, 25, 30, 50, 70, 90],
    );
  });

  it("treats messages sent before a reply as one turn", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), user("u3"), user("u4")];
    assert.isTrue(isTitleCheckDue(messages, "u2"));
    assert.isFalse(isTitleCheckDue(messages, "u3"));
    assert.isFalse(isTitleCheckDue(messages, "u4"));
  });

  it("checks right away when a turn grows long, off schedule", () => {
    // After turn 30 the next checkpoint is 50, so only the length can trigger turn 31.
    const thirtyTurns = Array.from({ length: 30 }, () => 100);
    assert.deepStrictEqual(
      dueTurns([...thirtyTurns, 2_500, 100]),
      [2, 4, 6, 9, 12, 15, 20, 25, 30, 31],
    );
    // Several messages in one turn add up the same way.
    const messages = [
      ...thirtyTurns.flatMap((chars, index) => [
        user(`u${index + 1}`, chars),
        assistant(`a${index + 1}`),
      ]),
      user("u31a", 1_500),
      user("u31b", 600),
    ];
    assert.isFalse(isTitleCheckDue(messages, "u31a"));
    assert.isTrue(isTitleCheckDue(messages, "u31b"));
  });

  it("counts a long turn as several, moving the schedule forward", () => {
    // Turn 3 (3,000 characters) counts as 3 turns, so the thread reaches the
    // 6 checkpoint at turn 4 instead of turn 6.
    assert.deepStrictEqual(dueTurns([100, 100, 3_000, 100, 100, 100]), [2, 3, 4]);
  });

  it("never checks the first turn, even a long one", () => {
    assert.isFalse(isTitleCheckDue([user("u1", 5_000)], "u1"));
  });

  it("ignores a bare /compact", () => {
    const compact = { ...user("c1"), isCompact: true };
    assert.isFalse(isTitleCheckDue([user("u1"), assistant("a1"), compact], "c1"));
    // It does not open a turn either, so the next real message is turn 2.
    assert.isTrue(
      isTitleCheckDue([user("u1"), assistant("a1"), compact, assistant("a2"), user("u2")], "u2"),
    );
  });
});

describe("isAutomaticTitleCommand", () => {
  it("accepts only the server's own title writes", () => {
    assert.isTrue(isAutomaticTitleCommand("server:thread-title-rename:1"));
    assert.isTrue(isAutomaticTitleCommand("server:thread-title-regeneration-complete:1"));
    assert.isFalse(isAutomaticTitleCommand("client-rename-1"));
    assert.isFalse(isAutomaticTitleCommand("server:bootstrap-thread-meta-update:1"));
    assert.isFalse(isAutomaticTitleCommand(null));
  });
});

type SeedMessage = { readonly role: "user" | "assistant"; readonly text: string };

const turnStartRequested = (threadId: ThreadId, messageId: MessageId) =>
  ({
    sequence: 1,
    eventId: EventId.make(`${threadId}:turn-start`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.turn-start-requested",
    occurredAt: NOW,
    commandId: CommandId.make(`${threadId}:turn-start`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, messageId, createdAt: NOW },
  }) as unknown as OrchestrationEvent;

// Seeds one thread, starts a turn for its last message, and returns what the reactor dispatched.
const runTurnStart = (input: {
  readonly threadId: string;
  readonly messages: ReadonlyArray<SeedMessage>;
  readonly titleCommandIds: ReadonlyArray<string>;
  readonly regenerationPending?: boolean;
}) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(input.threadId);
    const sql = yield* SqlClient.SqlClient;
    for (const [index, message] of input.messages.entries()) {
      const createdAt = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`${threadId}:msg-${index}`}, ${threadId}, NULL, ${message.role},
          ${message.text}, 0, ${createdAt}, ${createdAt})
      `;
    }
    for (const [index, commandId] of input.titleCommandIds.entries()) {
      yield* sql`
        INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
           command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${`${threadId}:title-${index}`}, 'thread', ${threadId}, ${index + 1},
          'thread.meta-updated', ${NOW}, ${commandId}, NULL, NULL, 'server',
          ${encodeMetaUpdatedPayload({ threadId, title: `Title ${index}`, updatedAt: NOW })}, '{}')
      `;
    }

    const lastMessageId = MessageId.make(`${threadId}:msg-${input.messages.length - 1}`);
    const dispatched: Array<OrchestrationCommand> = [];
    const streamDone = yield* Deferred.make<void>();
    const engine = {
      subscribeDomainEvents: Effect.succeed(
        Stream.concat(
          Stream.make(turnStartRequested(threadId, lastMessageId)),
          Stream.fromEffect(Deferred.succeed(streamDone, undefined)).pipe(Stream.drain),
        ),
      ),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 2 };
        }),
    } as unknown as OrchestrationEngineShape;
    const snapshots = {
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            id: threadId,
            title: "Current title",
            archivedAt: null,
            titleRegeneration: input.regenerationPending
              ? { requestId: CommandId.make("pending"), startedAt: NOW }
              : null,
          }),
        ),
    } as unknown as ProjectionSnapshotQueryShape;

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadTitleAutoRefreshReactor;
      yield* reactor.start();
      yield* Deferred.await(streamDone);
      yield* reactor.drain;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ThreadTitleAutoRefreshReactorLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, engine),
              Layer.succeed(ProjectionSnapshotQuery, snapshots),
              Layer.succeed(Crypto.Crypto, testCrypto),
            ),
          ),
        ),
      ),
    );
    return dispatched;
  });

const u = (text = "a short message"): SeedMessage => ({ role: "user", text });
const a: SeedMessage = { role: "assistant", text: "a reply" };
const secondTurn = [u(), a, u()];

it.layer(SqlitePersistenceMemory)("ThreadTitleAutoRefreshReactor", (it) => {
  it.effect("asks for a regeneration on the second turn of an auto-titled thread", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "auto-titled",
        messages: secondTurn,
        titleCommandIds: ["server:thread-title-rename:1"],
      });
      assert.strictEqual(dispatched.length, 1);
      const command = dispatched[0];
      assert.strictEqual(command?.type, "thread.meta.update");
      if (command?.type === "thread.meta.update") {
        assert.strictEqual(command.regenerateTitle, true);
        assert.isTrue(command.commandId.startsWith("server:thread-title-auto-refresh:"));
      }
    }),
  );

  it.effect("treats a thread with no title writes as auto-titled", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "never-titled",
        messages: secondTurn,
        titleCommandIds: [],
      });
      assert.strictEqual(dispatched.length, 1);
    }),
  );

  it.effect("leaves a manually renamed thread alone", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "manually-renamed",
        messages: secondTurn,
        titleCommandIds: ["server:thread-title-rename:1", "client-rename-1"],
      });
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("resumes once a requested regeneration replaces a manual title", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "regenerated-after-rename",
        messages: secondTurn,
        titleCommandIds: ["client-rename-1", "server:thread-title-regeneration-complete:1"],
      });
      assert.strictEqual(dispatched.length, 1);
    }),
  );

  it.effect("does not count a follow-up sent before any reply as a new turn", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "follow-up",
        messages: [...secondTurn, u()],
        titleCommandIds: ["server:thread-title-rename:1"],
      });
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  // Turn 3 only reaches the 4 checkpoint if its 2,500 characters count as 2.5 turns.
  it.effect("weighs a long message by its characters", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "long-message",
        messages: [...secondTurn, a, u("x".repeat(2_500))],
        titleCommandIds: ["server:thread-title-rename:1"],
      });
      assert.strictEqual(dispatched.length, 1);
    }),
  );

  it.effect("does not count a bare /compact as a turn", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "compacted",
        messages: [u(), a, u(" /compact ")],
        titleCommandIds: ["server:thread-title-rename:1"],
      });
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("skips while a regeneration is already pending", () =>
    Effect.gen(function* () {
      const dispatched = yield* runTurnStart({
        threadId: "pending-regeneration",
        messages: secondTurn,
        titleCommandIds: ["server:thread-title-rename:1"],
        regenerationPending: true,
      });
      assert.strictEqual(dispatched.length, 0);
    }),
  );
});
