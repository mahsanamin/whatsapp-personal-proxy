import { requireConfig, apiCall } from '../config.js'

export default function messagesCommand(program) {
  program.command('messages <channel>')
    .description('Read messages from a channel')
    .option('--limit <n>', 'Number of messages', '20')
    .option('--since <duration>', 'Duration like 24h, 7d')
    .option('--type <type>', 'Filter by type (text, image, etc.)')
    .option('--json', 'JSON output')
    .option('--quiet', 'Minimal output')
    .action(async (channel, opts) => {
      const config = requireConfig()

      // Resolve channel: could be a JID or display name
      let jid = channel
      if (!channel.includes('@')) {
        // Try to find by display name
        try {
          const channels = await apiCall(config, `/channels?search=${encodeURIComponent(channel)}`)
          if (channels.length > 0) {
            jid = channels[0].jid
          } else {
            console.error(`Channel not found: ${channel}`)
            process.exit(1)
          }
        } catch (err) {
          console.error(`Error: ${err.message}`)
          process.exit(1)
        }
      }

      let query = `?limit=${opts.limit}`
      if (opts.type) query += `&type=${opts.type}`

      if (opts.since) {
        const match = opts.since.match(/^(\d+)([hd])$/)
        if (match) {
          const ms = match[2] === 'h' ? parseInt(match[1]) * 3600000 : parseInt(match[1]) * 86400000
          const after = new Date(Date.now() - ms).toISOString()
          query += `&after=${encodeURIComponent(after)}`
        }
      }

      try {
        const messages = await apiCall(config, `/channels/${encodeURIComponent(jid)}/messages${query}`)

        if (opts.json) {
          console.log(JSON.stringify(messages, null, 2))
          return
        }

        const chalk = (await import('chalk')).default

        for (const msg of messages.reverse()) {
          const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          const sender = msg.is_from_me ? chalk.green('You') : chalk.dim(msg.from_jid?.split('@')[0] || '?')
          const body = msg.body || chalk.dim(`[${msg.type}]`)

          if (opts.quiet) {
            console.log(`${time} ${sender}: ${body}`)
          } else {
            console.log(`[${chalk.dim(time)}] ${sender} ${chalk.dim('—')} ${body}`)
          }
        }
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })
}
