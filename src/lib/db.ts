import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: ['warn', 'error'] })

// Always cache in global to prevent multiple instances in dev
globalForPrisma.prisma = db

// One-shot: switch to DELETE journal mode. Default WAL can grow the
// -wal sidecar to multi-GB and stall the query_engine IPC during the
// next checkpoint. DELETE rolls writes into the main .db file in a
// single fsync — simpler & avoids the IPC stall under sustained writes.
// Note: SQLite returns the current journal mode when queried, which
// Prisma interprets as "results returned" and throws an error. We use
// $queryRawUnsafe and ignore the result to avoid this.
;(async () => {
  try {
    await db.$queryRawUnsafe(`PRAGMA journal_mode = DELETE`)
  } catch {
    // Ignore — the PRAGMA still takes effect even if Prisma throws
  }
  // CR-D#3 fix: SQLite's default busy_timeout is 0 — any concurrent write
  // lock (compose $transaction, checkpoint upserts, recorder writes every
  // ~2.5s) instantly surfaces as SQLITE_BUSY "database is locked" 500s to
  // the recovery poller's reads. 5s of patient retry instead.
  try {
    await db.$queryRawUnsafe(`PRAGMA busy_timeout = 5000`)
  } catch {
    // Ignore — the PRAGMA still takes effect even if Prisma throws
  }
})()