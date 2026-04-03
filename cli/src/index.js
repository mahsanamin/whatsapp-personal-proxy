#!/usr/bin/env node
import { Command } from 'commander'
import { loadConfig, saveConfig, requireConfig, apiCall } from './config.js'
import sendCommand from './commands/send.js'
import messagesCommand from './commands/messages.js'
import tabsCommand from './commands/tabs.js'
import channelCommand from './commands/channel.js'
import watchCommand from './commands/watch.js'

const program = new Command()

program
  .name('wpp')
  .description('WhatsApp Personal Proxy CLI')
  .version('1.0.0')

// Config
const configCmd = program.command('config')

configCmd.command('set')
  .option('--server <url>', 'Server URL')
  .option('--token <token>', 'API token')
  .action((opts) => {
    const config = loadConfig()
    if (opts.server) config.server = opts.server
    if (opts.token) config.token = opts.token
    saveConfig(config)
    console.log('Config saved to ~/.wpp/config.yaml')
  })

configCmd.command('show')
  .action(() => {
    const config = loadConfig()
    console.log(`Server: ${config.server || '(not set)'}`)
    console.log(`Token:  ${config.token ? config.token.slice(0, 10) + '...' : '(not set)'}`)
    if (config.default_tab) console.log(`Default tab: ${config.default_tab}`)
  })

// Status
program.command('status')
  .description('Show WhatsApp connection status')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const config = requireConfig()
    try {
      const data = await apiCall(config, '/health')
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        const chalk = (await import('chalk')).default
        const statusColor = data.wa === 'open' ? chalk.green : data.wa === 'connecting' ? chalk.yellow : chalk.red
        console.log(`WhatsApp: ${statusColor(data.wa)}`)
        console.log(`Uptime:   ${data.uptime}s`)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// Reconnect
program.command('reconnect')
  .description('Trigger WhatsApp reconnect')
  .action(async () => {
    const config = requireConfig()
    try {
      const data = await apiCall(config, '/auth/wa/reconnect', { method: 'POST' })
      console.log(data.message)
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// Whitelist
const whitelistCmd = program.command('whitelist')

whitelistCmd.command('list')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    const config = requireConfig()
    const data = await apiCall(config, '/whitelist')
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
    } else {
      const Table = (await import('cli-table3')).default
      const table = new Table({ head: ['JID', 'Label', 'Added'] })
      data.forEach(w => table.push([w.jid, w.label || '', w.added_at || '']))
      console.log(table.toString())
    }
  })

whitelistCmd.command('add <number>')
  .option('--label <name>', 'Label')
  .action(async (number, opts) => {
    const config = requireConfig()
    await apiCall(config, '/whitelist', { method: 'POST', body: { jid: number, label: opts.label } })
    console.log(`Added ${number} to whitelist`)
  })

whitelistCmd.command('remove <number>')
  .action(async (number) => {
    const config = requireConfig()
    const list = await apiCall(config, '/whitelist')
    const jid = number.replace(/^\+/, '') + '@s.whatsapp.net'
    const entry = list.find(w => w.jid === jid || w.jid === number)
    if (!entry) {
      console.error('Not found in whitelist')
      process.exit(1)
    }
    await apiCall(config, `/whitelist/${entry.id}`, { method: 'DELETE' })
    console.log(`Removed ${number} from whitelist`)
  })

// Register sub-commands
sendCommand(program)
messagesCommand(program)
tabsCommand(program)
channelCommand(program)
watchCommand(program)

program.parse()
