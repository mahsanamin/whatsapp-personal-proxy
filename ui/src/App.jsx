import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Login from './pages/Login'
import Connect from './pages/Connect'
import Workspace from './pages/Workspace'
import Tokens from './pages/Tokens'
import { api } from './api/client'

export default function App() {
  const [authed, setAuthed] = useState(null) // null = loading

  useEffect(() => {
    api('/auth/wa/status')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
  }, [])

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
        <Route path="/login" element={authed ? <Navigate to="/" /> : <Login onLogin={() => setAuthed(true)} />} />
        <Route path="/connect" element={!authed ? <Navigate to="/login" /> : <Connect />} />
        <Route path="/tokens" element={!authed ? <Navigate to="/login" /> : <Tokens />} />
        <Route path="/" element={!authed ? <Navigate to="/login" /> : <Workspace />} />
      </Routes>
    </BrowserRouter>
  )
}
