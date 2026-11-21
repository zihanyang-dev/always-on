import { sql } from 'kysely';
import {
  DATABASE_SCHEMA,
  type Database,
  type DatabaseTransaction,
} from '../../infrastructure/database/index.ts';
import type { LeaseKey } from '../inbox/inbox-event.ts';
import { readInboxEvent } from '../inbox/persistence/inbox-leases.ts';
import type { WorkRunLease } from './work-item.ts';

type ClaimedRequest = { eventId: string; workId: string; token: string; expiresAt: Date };
type CompletedRun = LeaseKey & { progress: string };
type WorkRunQueue = {
  claim: (options?: { leaseMs?: number }) => Promise<WorkRunLease | null>;
  complete: (result: CompletedRun) => Promise<boolean>;
};

const REQUESTS = sql.table(`${DATABASE_SCHEMA}.work_run_requests`);
const NOW = sql<Date>`clock_timestamp()`;

export function createWorkRunQueue(db: Database): WorkRunQueue {
  const transaction = () => db.transaction().setIsolationLevel('read committed');

  return {
    claim,
    complete: (result) => transaction().execute((tx) => completeWorkRun(tx, result)),
  };

  function claim({ leaseMs = 30_000 }: { leaseMs?: number } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new RangeError('Work run lease must be a positive number of milliseconds');

    return transaction().execute((tx) => claimWorkRun(tx, leaseMs));
  }
}

async function claimWorkRun(
  transaction: DatabaseTransaction,
  leaseMs: number,
): Promise<WorkRunLease | null> {
  // A delayed or leased request holds its position ahead of later inputs to the same Work.
  const claimed = await sql<ClaimedRequest>`
    WITH ready AS (
      SELECT request.sequence
      FROM ${REQUESTS} AS request
      WHERE request.completed_at IS NULL
        AND request.available_at <= statement_timestamp()
        AND NOT EXISTS (
          SELECT 1
          FROM ${REQUESTS} AS earlier
          WHERE earlier.work_id = request.work_id
            AND earlier.sequence < request.sequence
            AND earlier.completed_at IS NULL
        )
      ORDER BY request.available_at, request.sequence
      LIMIT 1
      FOR UPDATE OF request SKIP LOCKED
    )
    UPDATE ${REQUESTS} AS request
    SET available_at = clock_timestamp() + make_interval(secs => ${leaseMs / 1000}),
        lease_token = gen_random_uuid()
    FROM ready
    WHERE request.sequence = ready.sequence
    RETURNING request.event_id AS "eventId", request.work_id AS "workId",
              request.lease_token AS token, request.available_at AS "expiresAt"
  `.execute(transaction);
  const [request] = claimed.rows;
  if (!request) return null;

  const work = await transaction
    .selectFrom('work_items')
    .select(['id as workId', 'goal', 'progress'])
    .where('id', '=', request.workId)
    .executeTakeFirstOrThrow();
  const event = await readInboxEvent(transaction, request.eventId);

  return { token: request.token, expiresAt: request.expiresAt, work, event };
}

async function completeWorkRun(
  transaction: DatabaseTransaction,
  { eventId, token, progress }: CompletedRun,
): Promise<boolean> {
  const request = await transaction
    .selectFrom('work_run_requests')
    .select('work_id')
    .where('event_id', '=', eventId)
    .where('lease_token', '=', token)
    .forUpdate()
    .executeTakeFirst();
  if (!request) return false;

  await transaction
    .selectFrom('work_items')
    .select('id')
    .where('id', '=', request.work_id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();

  const completed = await transaction
    .updateTable('work_run_requests')
    .set({ completed_at: NOW, lease_token: null })
    .where('event_id', '=', eventId)
    .where('available_at', '>', NOW)
    .returning('event_id')
    .executeTakeFirst();
  if (!completed) return false;

  await transaction
    .updateTable('work_items')
    .set({ progress })
    .where('id', '=', request.work_id)
    .executeTakeFirstOrThrow();

  return true;
}
