import { nanoid } from 'nanoid'
import { db } from '../db/index.js'
import { requireScope } from '../middleware/token.js'

export default async function tabRoutes(fastify) {
  fastify.get('/tabs', {
    preHandler: requireScope('tabs:manage'),
  }, async () => {
    return db.prepare(`
      SELECT t.*, COUNT(cm.jid) AS channel_count
      FROM tabs t
      LEFT JOIN channel_meta cm ON cm.tab_id = t.id
      GROUP BY t.id
      ORDER BY t.position
    `).all()
  })

  fastify.post('/tabs', {
    preHandler: requireScope('tabs:manage'),
  }, async (request, reply) => {
    const { name, color } = request.body || {}

    if (!name) {
      return reply.code(400).send({ error: 'Tab name required', code: 'BAD_INPUT' })
    }

    const id = nanoid()
    const maxPos = db.prepare('SELECT MAX(position) AS max FROM tabs').get()
    const position = (maxPos?.max ?? -1) + 1

    db.prepare(
      'INSERT INTO tabs (id, name, color, position) VALUES (?, ?, ?, ?)'
    ).run(id, name, color || '#6366f1', position)

    return db.prepare('SELECT * FROM tabs WHERE id = ?').get(id)
  })

  fastify.patch('/tabs/:id', {
    preHandler: requireScope('tabs:manage'),
  }, async (request, reply) => {
    const { id } = request.params
    const allowed = ['name', 'color', 'position']
    const updates = []
    const params = []

    for (const key of allowed) {
      if (request.body[key] !== undefined) {
        updates.push(`${key} = ?`)
        params.push(request.body[key])
      }
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update', code: 'BAD_INPUT' })
    }

    params.push(id)
    const result = db.prepare(`UPDATE tabs SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Tab not found', code: 'NOT_FOUND' })
    }

    return db.prepare('SELECT * FROM tabs WHERE id = ?').get(id)
  })

  fastify.delete('/tabs/:id', {
    preHandler: requireScope('tabs:manage'),
  }, async (request, reply) => {
    const { id } = request.params

    // Unassign all channels first (FK ON DELETE SET NULL handles this, but be explicit)
    db.prepare('UPDATE channel_meta SET tab_id = NULL WHERE tab_id = ?').run(id)

    const result = db.prepare('DELETE FROM tabs WHERE id = ?').run(id)
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Tab not found', code: 'NOT_FOUND' })
    }

    return { ok: true }
  })
}
