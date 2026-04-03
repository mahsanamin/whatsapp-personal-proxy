export async function requireSession(request, reply) {
  if (request.session?.authenticated) return
  reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHORIZED' })
}
