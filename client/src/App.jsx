import React, { useEffect, useMemo, useState } from 'react'

const SERVER = 'http://localhost:3001'

function useQuery() {
  return useMemo(() => new URLSearchParams(window.location.search), [])
}

export default function App() {
  const query = useQuery()
  const [userId, setUserId] = useState('')
  const [user, setUser] = useState(null)
  const [repos, setRepos] = useState([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [linkCode, setLinkCode] = useState('')
  const [genLoading, setGenLoading] = useState(false)

  useEffect(() => {
    const qUserId = query.get('userId')
    const stored = localStorage.getItem('userId')
    const effective = qUserId || stored || ''
    if (qUserId) localStorage.setItem('userId', qUserId)
    setUserId(effective)
  }, [query])

  useEffect(() => {
    const load = async () => {
      if (!userId) return
      const res = await fetch(`${SERVER}/api/user?userId=${encodeURIComponent(userId)}`)
      const data = await res.json()
      if (data?.user) setUser(data.user)
    }
    load()
  }, [userId])

  const connectUrl = `${SERVER}/auth/github`

  const loadRepos = async () => {
    if (!userId) return alert('Connect GitHub first')
    setLoadingRepos(true)
    try {
      const tokenRes = await fetch(`${SERVER}/api/request-mediator-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, allowedActions: ['read_repo'] }),
      })
      const { mediatorJwt } = await tokenRes.json()
      const execRes = await fetch(`${SERVER}/mediator/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediatorJwt, action: 'read_repo' }),
      })
      const data = await execRes.json()
      setRepos(data?.repos || [])
    } finally {
      setLoadingRepos(false)
    }
  }

  const generateLinkCode = async () => {
    if (!userId) return alert('Connect GitHub first')
    setGenLoading(true)
    try {
      const res = await fetch(`${SERVER}/telegram/generate-link-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const data = await res.json()
      setLinkCode(data?.code || '')
    } finally {
      setGenLoading(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Mediator Demo</h1>
          <a href={connectUrl} className="inline-flex">
            <button className="px-4 py-2 rounded-md bg-black text-white hover:bg-gray-800">Connect GitHub</button>
          </a>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 grid md:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg border p-5">
          <h2 className="text-lg font-semibold mb-3">Quick Start</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
            <li>Click <span className="font-medium">Connect GitHub</span> above and approve access.</li>
            <li>After redirect, your <span className="font-medium">userId</span> is saved automatically. You don’t need to type it.</li>
            <li>Click <span className="font-medium">Generate Link Code</span>, then send that code to the Telegram bot.</li>
            <li>In Telegram, try: <span className="font-mono">create repo demo-1</span> or <span className="font-mono">delete repo demo-1</span>.</li>
          </ol>
          <p className="mt-3 text-xs text-gray-500">Note: We use OAuth (no manual token pasting). Repo delete requires the GitHub <span className="font-mono">delete_repo</span> scope.</p>
        </section>

        <section className="bg-white rounded-lg border p-5">
          <h2 className="text-lg font-semibold mb-3">Your Account</h2>
          <div className="space-y-2 text-sm">
            <div><span className="font-medium">UserId:</span> <span className="font-mono break-all">{userId || '—'}</span></div>
            <div><span className="font-medium">GitHub:</span> {user?.username || '—'}</div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button onClick={generateLinkCode} disabled={!userId || genLoading} className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-50">Generate Link Code</button>
            {linkCode && <span className="text-sm">Your code: <span className="font-mono px-2 py-1 rounded bg-gray-100">{linkCode}</span></span>}
          </div>
        </section>

        <section className="bg-white rounded-lg border p-5 md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Repositories</h2>
            <button onClick={loadRepos} disabled={loadingRepos || !userId} className="px-3 py-2 rounded-md bg-gray-900 text-white text-sm hover:bg-gray-800 disabled:opacity-50">Load Repos (via Mediator)</button>
          </div>
          {loadingRepos && <div className="text-sm text-gray-500">Loading…</div>}
          <ul className="divide-y">
            {repos.map((r) => (
              <li key={r.id} className="py-2 text-sm flex items-center justify-between">
                <div className="font-mono">{r.full_name}</div>
                <a href={r.html_url} target="_blank" className="text-blue-600 hover:underline">Open</a>
              </li>
            ))}
            {!repos.length && !loadingRepos && <li className="text-sm text-gray-500">No repositories loaded yet.</li>}
          </ul>
        </section>
      </main>

      <footer className="text-center text-xs text-gray-500 py-6">Demo build — minimal UI for testing OAuth, Mediator, and Telegram.</footer>
    </div>
  )
}


