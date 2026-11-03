import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Activity, Loader2, CheckCircle2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Register() {
  const { register } = useAuth()
  const navigate     = useNavigate()

  const [form, setForm]       = useState({ username: '', email: '', password: '', confirm: '' })
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    if (form.password !== form.confirm) {
      setError("Passwords don't match")
      return
    }
    if (new TextEncoder().encode(form.password).length < 12 || new TextEncoder().encode(form.password).length > 72) {
      setError('Password must be 12–72 UTF-8 bytes')
      return
    }

    setLoading(true)
    try {
      await register(form.username.trim(), form.email.trim().toLowerCase(), form.password)
      setSuccess(true)
      setTimeout(() => navigate('/login'), 1800)
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="success-banner">
            <CheckCircle2 size={48} className="success-icon" />
            <h2>Account created!</h2>
            <p>Redirecting to login…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Activity size={28} strokeWidth={2.5} className="brand-icon" />
          <span className="brand-name">PaperTrade</span>
        </div>
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-tagline">Start with ₹10,00,000 in virtual cash.</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label className="form-label" htmlFor="username">Username</label>
            <input
              id="username" name="username" type="text"
              className="form-input" value={form.username}
              onChange={handleChange} placeholder="trader_joe"
              autoComplete="username" required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="email">Email</label>
            <input
              id="email" name="email" type="email"
              className="form-input" value={form.email}
              onChange={handleChange} placeholder="you@example.com"
              autoComplete="email" required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input
              id="password" name="password" type="password"
              className="form-input" value={form.password}
              onChange={handleChange} placeholder="12–72 UTF-8 bytes"
              autoComplete="new-password" required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="confirm">Confirm Password</label>
            <input
              id="confirm" name="confirm" type="password"
              className="form-input" value={form.confirm}
              onChange={handleChange} placeholder="••••••••"
              autoComplete="new-password" required
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : 'Create Account'}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account?{' '}
          <Link to="/login" className="link">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
