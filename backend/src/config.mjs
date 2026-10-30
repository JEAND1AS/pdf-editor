import 'dotenv/config'
import path from 'node:path'

const asBoolean = (value) => value === 'true'

export function readConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production'
  const cookieSecret = env.COOKIE_SECRET

  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('COOKIE_SECRET precisa ter ao menos 32 caracteres aleatórios.')
  }

  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT precisa ser uma porta válida.')
  }

  const clientOrigin = env.CLIENT_ORIGIN ?? 'http://localhost:5173'
  try {
    new URL(clientOrigin)
  } catch {
    throw new Error('CLIENT_ORIGIN precisa ser uma URL absoluta.')
  }

  if (isProduction && !clientOrigin.startsWith('https://')) {
    throw new Error('Em produção, CLIENT_ORIGIN deve usar HTTPS.')
  }

  return {
    isProduction,
    host: env.HOST ?? '127.0.0.1',
    port,
    clientOrigin,
    cookieSecret,
    trustProxy: asBoolean(env.TRUST_PROXY),
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
  }
}
