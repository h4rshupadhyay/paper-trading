import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { RegionProvider } from './context/RegionContext'
import Sidebar from './components/Sidebar'

const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const StockDetail = lazy(() => import('./pages/StockDetail'))
const Orders = lazy(() => import('./pages/Orders'))
const Watchlist = lazy(() => import('./pages/Watchlist'))
const PendingOrders = lazy(() => import('./pages/PendingOrders'))
const Alerts = lazy(() => import('./pages/Alerts'))
const Notes = lazy(() => import('./pages/Notes'))
const Analytics = lazy(() => import('./pages/Analytics'))

function PageLoading() {
  return (
    <div className="splash" role="status" aria-label="Loading page">
      <div className="splash-spinner" aria-hidden="true" />
    </div>
  )
}

/** Wraps authenticated routes — redirects to /login if not logged in */
function ProtectedLayout() {
  const { user, loading } = useAuth()

  if (loading) {
    return <PageLoading />
  }

  if (!user) return <Navigate to="/login" replace />

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-area">
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  )
}

/** Wraps public routes — redirects to /dashboard if already logged in */
function PublicLayout() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/dashboard" replace />
  return <Suspense fallback={<PageLoading />}><Outlet /></Suspense>
}

export default function App() {
  return (
    <ThemeProvider>
      <RegionProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public */}
            <Route element={<PublicLayout />}>
              <Route path="/login"    element={<Login />} />
              <Route path="/register" element={<Register />} />
            </Route>

            {/* Protected */}
            <Route element={<ProtectedLayout />}>
              <Route path="/dashboard"      element={<Dashboard />} />
              <Route path="/stocks/:ticker" element={<StockDetail />} />
              <Route path="/orders"         element={<Orders />} />
              <Route path="/watchlist"      element={<Watchlist />} />
              <Route path="/pending-orders" element={<PendingOrders />} />
              <Route path="/alerts"         element={<Alerts />} />
              <Route path="/notes"          element={<Notes />} />
              <Route path="/analytics"      element={<Analytics />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
      </RegionProvider>
    </ThemeProvider>
  )
}
