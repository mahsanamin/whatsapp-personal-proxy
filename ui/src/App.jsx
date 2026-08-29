import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Login from './pages/Login'
import Connect from './pages/Connect'
import Workspace from './pages/Workspace'
import Tokens from './pages/Tokens'
import Whitelist from './pages/Whitelist'
import { api } from './api/client'

export default function App() {
  const [authed, setAuthed] = useState(null) // null = loading
  const [linked, setLinked] = useState(null) // null = not yet known

  const checkLink = () =>
    api('/auth/wa/status')
      .then(data => setLinked(Boolean(data.linked)))
      .catch(() => setLinked(null))

  useEffect(() => {
    api('/tokens')
      .then(() => { setAuthed(true); return checkLink() })
      .catch(() => setAuthed(false))
  }, [])

  const handleLogin = () => { setAuthed(true); checkLink() }

  const handleLogout = () => {
    api('/auth/logout', { method: 'POST' }).catch(() => {})
    setAuthed(false)
  }

  if (authed === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg text-neutral-500">
        Loading...
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={authed ? <Navigate to="/" /> : <Login onLogin={handleLogin} />} />
        <Route path="/connect" element={!authed ? <Navigate to="/login" /> : <Connect />} />
        <Route path="/tokens" element={!authed ? <Navigate to="/login" /> : <Tokens onLogout={handleLogout} />} />
        <Route path="/whitelist" element={!authed ? <Navigate to="/login" /> : <Whitelist />} />
        {/* Nothing to show in the workspace until a phone is paired, so send a
            fresh install straight to the QR page instead of an endless sync. */}
        <Route
          path="/"
          element={
            !authed ? <Navigate to="/login" />
              : linked === false ? <Navigate to="/connect" />
              : <Workspace onLogout={handleLogout} />
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
