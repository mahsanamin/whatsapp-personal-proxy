import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// In the container the app root is /app (src/api -> ../..); in a source
// checkout the CLI lives at the repo root (src/api -> ../../..).
const CLI_CANDIDATES = process.env.CLI_PATH
  ? [process.env.CLI_PATH]
  : [path.resolve(HERE, '../../wpp'), path.resolve(HERE, '../../../wpp')]

async function findCli() {
  for (const candidate of CLI_CANDIDATES) {
    try {
      await stat(candidate)
      return candidate
    } catch (_) {}
  }
  return null
}

/**
 * Serves the `wpp` CLI itself so a new machine can bootstrap with one curl.
 * Deliberately unauthenticated: the script holds no secrets, and the machine
 * needs it *before* it has a token to authenticate with.
 */
export default async function cliRoutes(fastify) {
  fastify.get('/cli/wpp', async (request, reply) => {
    const cliPath = await findCli()
    if (!cliPath) {
      return reply.code(404).send({ error: 'CLI not bundled with this server', code: 'NOT_FOUND' })
    }

    reply.header('Content-Type', 'text/x-python; charset=utf-8')
    reply.header('Content-Disposition', 'inline; filename="wpp"')
    reply.header('Cache-Control', 'no-cache')
    return reply.send(createReadStream(cliPath))
  })

  // The exact one-liner to paste on a new machine. The UI renders this.
  fastify.get('/cli/install-command', async () => {
    const base = config.publicUrl.replace(/\/$/, '')
    return {
      url: `${base}/api/cli/wpp`,
      install: `curl -fsSL ${base}/api/cli/wpp -o ~/.local/bin/wpp && chmod 755 ~/.local/bin/wpp`,
      install_system: `sudo curl -fsSL ${base}/api/cli/wpp -o /usr/local/bin/wpp && sudo chmod 755 /usr/local/bin/wpp`,
      connect: `wpp connect ${base}`,
    }
  })
}
