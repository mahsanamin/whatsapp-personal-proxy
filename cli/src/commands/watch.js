import { requireConfig, apiCall } from '../config.js'
import WebSocket from 'ws'

export default function watchCommand(program) {
  program.command('watch')
    .description('Stream incoming messages in real-time')
    .option('--tab <name>', 'Filter by tab')
    .option('--channel <name>', 'Filter by channel')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const config = requireConfig()
      const chalk = (await import('chalk')).default

      const url = config.server.replace(/^http/, 'ws').replace(/\/$/, '')
      const ws = new WebSocket(`${url}/ws?token=${config.token}`)

      ws.on('open', async () => {
        console.log(chalk.dim('Connected. Watching for messages...\n'))

        // Subscribe to tab or channel if specified
        if (opts.tab) {
          const tabs = await apiCall(config, '/tabs')
          const tab = tabs.find(t => t.name.toLowerCase() === opts.tab.toLowerCase())
          if (tab) {
            ws.send(JSON.stringify({ action: 'subscribe_tab', tab_id: tab.id }))
            console.log(chalk.dim(`Filtering: tab "${tab.name}"\n`))
          }
        }

        if (opts.channel) {
          let jid = opts.channel
          if (!opts.channel.includes('@')) {
            const channels = await apiCall(config, `/channels?search=${encodeURIComponent(opts.channel)}`)
            if (channels.length > 0) jid = channels[0].jid
          }
          ws.send(JSON.stringify({ action: 'subscribe', jids: [jid] }))
          console.log(chalk.dim(`Filtering: channel "${jid}"\n`))
        }
      })

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())

          if (opts.json) {
            console.log(JSON.stringify(msg))
            return
          }

          if (msg.event === 'message.new') {
            const d = msg.data
            const time = new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            const sender = d.is_from_me
              ? chalk.green('You')
              : chalk.white(d.from_jid?.split('@')[0] || '?')
            const channel = d.jid.endsWith('@g.us') ? chalk.dim(` (${d.jid.split('@')[0]})`) : ''
            const body = d.body || chalk.dim(`[${d.type}]`)

            console.log(`[${chalk.dim(time)}] ${sender}${channel} ${chalk.dim('-')} ${body}`)
          }

          if (msg.event === 'wa.status') {
            const s = msg.data.status
            const color = s === 'open' ? chalk.green : s === 'connecting' ? chalk.yellow : chalk.red
            console.log(chalk.dim(`[status] `) + color(s))
          }
        } catch (e) {
          // ignore
        }
      })

      ws.on('close', () => {
        console.log(chalk.red('\nDisconnected'))
        process.exit(0)
      })

      ws.on('error', (err) => {
        console.error(chalk.red(`WebSocket error: ${err.message}`))
        process.exit(1)
      })

      // Keep alive
      process.on('SIGINT', () => {
        ws.close()
        process.exit(0)
      })
    })
}
