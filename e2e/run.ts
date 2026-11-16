// Run only against disposable local data; never read application DATABASE_URL.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
const database = 'paddock_e2e_test'
const variable = 'E2E_DATABASE_URL'
const external = process.env[variable]
if (external) {
  const url = new URL(external)
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.pathname.endsWith('_test')
  )
    throw new Error(
      `${variable} must name a disposable local database ending in _test`
    )
}
const temp = external ? undefined : mkdtempSync(join(tmpdir(), `${database}-`))
const run = (command: string[], env = process.env) => {
  const result = spawnSync(command[0], command.slice(1), {
    env,
    stdio: 'inherit'
  })
  if (result.status !== 0)
    throw new Error(`${command[0]} failed (${result.status})`)
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
let started = false
let child: ReturnType<typeof spawn> | undefined
function cleanup() {
  child?.kill('SIGTERM')
  if (started)
    spawnSync(
      'pg_ctl',
      ['-D', join(temp!, 'data'), '-m', 'immediate', '-w', 'stop'],
      { stdio: 'ignore' }
    )
  if (temp) rmSync(temp, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
let exitCode = 1
try {
  let url = external
  if (temp) {
    const port = await freePort()
    const pgEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' }
    run(
      [
        'initdb',
        '-D',
        join(temp, 'data'),
        '-U',
        'postgres',
        '--auth=trust',
        '--locale=C',
        '-E',
        'UTF8'
      ],
      pgEnv
    )
    run(
      [
        'pg_ctl',
        '-D',
        join(temp, 'data'),
        '-l',
        join(temp, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k ''`,
        '-w',
        'start'
      ],
      pgEnv
    )
    started = true
    run([
      'createdb',
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'postgres',
      database
    ])
    url = `postgres://postgres@127.0.0.1:${port}/${database}`
  }
  const env = { ...process.env, [variable]: url, DATABASE_URL: url }
  run(['bun', 'run', 'setup'], env)
  child = spawn(
    'bunx',
    [
      '--no-install',
      'playwright',
      'test',
      '--config',
      'e2e/playwright.config.ts',
      ...process.argv.slice(2)
    ],
    { env, stdio: 'inherit' }
  )
  exitCode = await new Promise<number>((resolve, reject) => {
    child!.once('error', reject)
    child!.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  cleanup()
}
process.exit(exitCode)
