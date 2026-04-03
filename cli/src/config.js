import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import yaml from 'js-yaml'

const CONFIG_DIR = join(homedir(), '.wpp')
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml')

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return { server: null, token: null, default_tab: null }
  }
  return yaml.load(readFileSync(CONFIG_FILE, 'utf8')) || {}
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, yaml.dump(config), 'utf8')
}

export function requireConfig() {
  const config = loadConfig()
  if (!config.server || !config.token) {
    console.error('Not configured. Run: wpp config set --server <url> --token <token>')
    process.exit(1)
  }
  return config
}

export async function apiCall(config, path, opts = {}) {
  const url = `${config.server.replace(/\/$/, '')}/api${path}`
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      ...opts.headers,
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }

  return res.json()
}
