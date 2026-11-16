import { afterAll, test } from 'bun:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { connection, closeConnection } from '../server/database.ts'

// A disposable database only: the refusal test creates and drops a role.
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgres://postgres:paddock@127.0.0.1:55432/paddock_test'
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must name a database ending in _test')
const admin = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 2
})
afterAll(() => admin.end())

// Point the lazy application client at another database for one test.
async function withApplicationUrl(url: string, run: () => Promise<void>) {
  const previous = process.env.DATABASE_URL
  const passwordFile = process.env.DATABASE_PASSWORD_FILE
  process.env.DATABASE_URL = url
  delete process.env.DATABASE_PASSWORD_FILE
  try {
    await run()
  } finally {
    await closeConnection()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    if (passwordFile !== undefined)
      process.env.DATABASE_PASSWORD_FILE = passwordFile
  }
}

test('concurrent first callers share one application client', async () => {
  await withApplicationUrl(
    'postgres://unused@127.0.0.1:1/paddock_test',
    async () => {
      const clients = await Promise.all(Array.from({ length: 16 }, connection))
      assert.equal(new Set(clients).size, 1)
      assert.equal(clients[0]!.options.max, 4)
      assert.equal(clients[0]!.options.idle_timeout, 20)
      assert.equal(clients[0]!.options.connect_timeout, 2)
    }
  )
})

// postgres.js v4 retries "too many connections" (53300) until connect_timeout;
// v3 rejected at once. The application client must still fail within seconds.
test('a refused application connection rejects with 53300 within seconds', async () => {
  const role = 'refused_' + randomUUID().replaceAll('-', '')
  await admin.unsafe(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER CONNECTION LIMIT 1`
  )
  const url = new URL(databaseUrl)
  url.username = role
  url.password = ''
  const holder = postgres(url.toString(), { max: 1, connect_timeout: 2 })
  try {
    const [database] = await admin`SELECT current_database() AS name`
    const name = String(database!.name).replaceAll('"', '""')
    await admin.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`)
    // Hold the role's only connection, so the application client is refused.
    const held = await holder.reserve()
    try {
      await held`SELECT 1`
      await withApplicationUrl(url.toString(), async () => {
        const app = await connection()
        const started = performance.now()
        const error = await app`SELECT 1`.then(
          () => assert.fail('The connection over the role limit must fail'),
          (error: { code?: string }) => error
        )
        const elapsed = performance.now() - started
        assert.equal(error.code, '53300')
        assert.ok(elapsed < 6000, `Refused after ${Math.round(elapsed)} ms`)
      })
    } finally {
      held.release()
    }
  } finally {
    await holder.end()
    await admin.unsafe(`DROP OWNED BY "${role}"`)
    await admin.unsafe(`DROP ROLE "${role}"`)
  }
}, 15000)
