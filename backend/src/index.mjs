import { buildApp } from './app.mjs'
import { readConfig } from './config.mjs'

const config = readConfig()
const app = await buildApp(config)

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
