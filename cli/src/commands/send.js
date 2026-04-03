import { requireConfig, apiCall } from '../config.js'

export default function sendCommand(program) {
  const send = program.command('send')

  send.command('personal <number> <message>')
    .description('Send to a personal number')
    .option('--json', 'JSON output')
    .action(async (number, message, opts) => {
      const config = requireConfig()
      try {
        const data = await apiCall(config, '/personal/send', {
          method: 'POST',
          body: { to: number, message },
        })
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2))
        } else {
          const chalk = (await import('chalk')).default
          console.log(chalk.green('Sent'), `messageId: ${data.messageId}`)
        }
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })

  send.command('others <number> <message>')
    .description('Send to a whitelisted number')
    .option('--json', 'JSON output')
    .action(async (number, message, opts) => {
      const config = requireConfig()
      try {
        const data = await apiCall(config, '/others/send', {
          method: 'POST',
          body: { to: number, message },
        })
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2))
        } else {
          const chalk = (await import('chalk')).default
          console.log(chalk.green('Sent'), `messageId: ${data.messageId}`)
        }
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })

  send.command('group <jid> <message>')
    .description('Send to a group')
    .option('--json', 'JSON output')
    .action(async (jid, message, opts) => {
      const config = requireConfig()
      try {
        const data = await apiCall(config, '/groups/send', {
          method: 'POST',
          body: { jid, message },
        })
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2))
        } else {
          const chalk = (await import('chalk')).default
          console.log(chalk.green('Sent'), `messageId: ${data.messageId}`)
        }
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })
}
