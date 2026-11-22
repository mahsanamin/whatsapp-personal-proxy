/**
 * Keeps exactly one WhatsApp connection attempt in charge.
 *
 * Every (re)connect calls `begin()` and gets a token. Only the holder of the
 * latest token may react to its socket's events or schedule a retry. Without
 * this, ending the old socket fired its own "close" handler, which scheduled a
 * reconnect that replaced the socket just created: each extra socket showed a
 * new QR code within a couple of seconds, so codes changed mid-scan.
 */
export function createConnectionGate({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let generation = 0
  let timer = null

  const cancelPending = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    /** Start a new attempt; supersedes every earlier token and pending retry. */
    begin() {
      cancelPending()
      generation += 1
      return generation
    },

    isCurrent(token) {
      return token === generation
    },

    /**
     * Schedule `fn` after `delayMs`, only if `token` is still current. At most
     * one retry is pending at a time. Returns whether it was scheduled.
     */
    retryLater(token, delayMs, fn) {
      if (token !== generation) return false
      cancelPending()
      timer = setTimer(() => {
        timer = null
        if (token === generation) fn()
      }, delayMs)
      return true
    },
  }
}
