import { requireConfig, apiCall } from '../config.js'

export default function tabsCommand(program) {
  const tabs = program.command('tabs')

  tabs.command('list')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const config = requireConfig()
      const data = await apiCall(config, '/tabs')
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        const Table = (await import('cli-table3')).default
        const table = new Table({ head: ['ID', 'Name', 'Color', 'Channels'] })
        data.forEach(t => table.push([t.id, t.name, t.color, t.channel_count]))
        console.log(table.toString())
      }
    })

  tabs.command('create <name>')
    .option('--color <hex>', 'Tab color')
    .option('--json', 'JSON output')
    .action(async (name, opts) => {
      const config = requireConfig()
      const data = await apiCall(config, '/tabs', {
        method: 'POST',
        body: { name, color: opts.color },
      })
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        console.log(`Created tab: ${data.name} (${data.id})`)
      }
    })

  tabs.command('delete <id>')
    .action(async (id) => {
      const config = requireConfig()
      await apiCall(config, `/tabs/${id}`, { method: 'DELETE' })
      console.log('Tab deleted')
    })
}
