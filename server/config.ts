import path from 'node:path'
import { readAuthEnv } from './auth-env.ts'

export const config = {
  port: Number(process.env.PORT || 3000),
  appUrl: new URL(process.env.APP_URL || 'http://localhost:3000').origin,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  root: process.cwd(),
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  embyUrl: (process.env.EMBY_URL || '').replace(/\/$/, ''),
  embyKey: process.env.EMBY_API_KEY || ''
}
function betterAuthConfigured() {
  try {
    readAuthEnv()
    return true
  } catch {
    return false
  }
}
// Administration (and scheduled inference) stay closed until sign-in is fully
// configured.
export const authConfigured = betterAuthConfigured()
