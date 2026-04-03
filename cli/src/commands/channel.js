import { requireConfig, apiCall } from '../config.js'

export default function channelCommand(program) {
  const ch = program.command('channel')

  ch.command('list')
    .option('--tab <name>', 'Filter by tab name')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const config = requireConfig()

      let query = ''
      if (opts.tab) {
        // Resolve tab name to ID
        const tabs = await apiCall(config, '/tabs')
        const tab = tabs.find(t => t.name.toLowerCase() === opts.tab.toLowerCase())
        if (tab) query = `?tab=${tab.id}`
      }

      const data = await apiCall(config, `/channels${query}`)

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        const Table = (await import('cli-table3')).default
        const table = new Table({ head: ['JID', 'Name', 'Tab', 'Unread'] })
        data.forEach(c => table.push([
          c.jid,
          c.display_name || '',
          c.tab_id || 'inbox',
          c.unread_count || 0,
        ]))
        console.log(table.toString())
      }
    })

  ch.command('move <channel> --tab <name>')
    .description('Move channel to a tab')
    .requiredOption('--tab <name>', 'Tab name')
    .action(async (channel, opts) => {
      const config = requireConfig()

      // Resolve channel
      let jid = channel
      if (!channel.includes('@')) {
        const channels = await apiCall(config, `/channels?search=${encodeURIComponent(channel)}`)
        if (channels.length === 0) { console.error('Channel not found'); process.exit(1) }
        jid = channels[0].jid
      }

      // Resolve tab
      const tabs = await apiCall(config, '/tabs')
      const tab = tabs.find(t => t.name.toLowerCase() === opts.tab.toLowerCase())
      if (!tab) { console.error('Tab not found'); process.exit(1) }

      await apiCall(config, `/channels/${encodeURIComponent(jid)}`, {
        method: 'PATCH',
        body: { tab_id: tab.id },
      })
      console.log(`Moved ${jid} to ${tab.name}`)
    })

  ch.command('mute <channel>')
    .action(async (channel) => {
      const config = requireConfig()
      let jid = channel
      if (!channel.includes('@')) {
        const channels = await apiCall(config, `/channels?search=${encodeURIComponent(channel)}`)
        if (channels.length === 0) { console.error('Channel not found'); process.exit(1) }
        jid = channels[0].jid
      }
      await apiCall(config, `/channels/${encodeURIComponent(jid)}`, { method: 'PATCH', body: { is_muted: 1 } })
      console.log(`Muted ${jid}`)
    })

  ch.command('archive <channel>')
    .action(async (channel) => {
      const config = requireConfig()
      let jid = channel
      if (!channel.includes('@')) {
        const channels = await apiCall(config, `/channels?search=${encodeURIComponent(channel)}`)
        if (channels.length === 0) { console.error('Channel not found'); process.exit(1) }
        jid = channels[0].jid
      }
      await apiCall(config, `/channels/${encodeURIComponent(jid)}`, { method: 'PATCH', body: { is_archived: 1 } })
      console.log(`Archived ${jid}`)
    })

  ch.command('note <channel> <note>')
    .action(async (channel, note) => {
      const config = requireConfig()
      let jid = channel
      if (!channel.includes('@')) {
        const channels = await apiCall(config, `/channels?search=${encodeURIComponent(channel)}`)
        if (channels.length === 0) { console.error('Channel not found'); process.exit(1) }
        jid = channels[0].jid
      }
      await apiCall(config, `/channels/${encodeURIComponent(jid)}`, { method: 'PATCH', body: { notes: note } })
      console.log(`Note added to ${jid}`)
    })
}
