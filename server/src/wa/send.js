/**
 * Every message the server sends goes through here.
 *
 * In Baileys 6.7.24 sendMessage echoes the sent message back through
 * upsertMessage, which is a buffered function: it switches event buffering on
 * and leaves flushing to the socket's own processing loop. Called from a route,
 * outside that loop, it held messages.upsert and every other bufferable event
 * until some unrelated incoming node flushed them. Anything that reacts to the
 * next incoming message (the auto-replier, the console) then saw it late.
 *
 * The echo is not queued until a process.nextTick after sendMessage resolves,
 * and then runs inside processingMutex. Flushing straight after the send would
 * run before buffering even starts, so wait for the tick, queue behind the
 * echo on the same mutex, and only then flush.
 */
export async function sendMessage(sock, jid, content, options) {
  try {
    return await sock.sendMessage(jid, content, options)
  } finally {
    flushAfterEcho(sock)
  }
}

export function flushAfterEcho(sock) {
  return new Promise(resolve => {
    setImmediate(() => {
      let queued
      try {
        queued = sock.processingMutex?.mutex
          ? sock.processingMutex.mutex(async () => {})
          : Promise.resolve()
      } catch (_) {
        queued = Promise.resolve()
      }
      Promise.resolve(queued)
        .catch(() => {})
        .finally(() => {
          try { sock.ev?.flush?.() } catch (_) {}
          resolve()
        })
    })
  })
}
