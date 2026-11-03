import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Star, ClipboardList,
  LogOut, Activity, Bell, FileText, Clock, BarChart2,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useRegion } from '../context/RegionContext'

const NAV = [
  { to: '/dashboard',      icon: LayoutDashboard, label: 'Dashboard'      },
  { to: '/watchlist',      icon: Star,             label: 'Watchlist'      },
  { to: '/orders',         icon: ClipboardList,    label: 'Orders'         },
  { to: '/pending-orders', icon: Clock,            label: 'Pending Orders' },
  { to: '/alerts',         icon: Bell,             label: 'Alerts'         },
  { to: '/notes',          icon: FileText,         label: 'Notes'          },
  { to: '/analytics',      icon: BarChart2,        label: 'Analytics'      },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { formatCurrency } = useRegion()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="sidebar-brand">
        <Activity size={22} strokeWidth={2.5} className="brand-icon" />
        <span className="brand-name">PaperTrade</span>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={label}
            title={label}
            className={({ isActive }) =>
              `sidebar-link${isActive ? ' active' : ''}`
            }
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        {user && (
          <div className="sidebar-user">
            <div className="user-avatar">
              {user.username?.[0]?.toUpperCase() || 'U'}
            </div>
            <div className="user-info">
              <span className="user-name">{user.username}</span>
              <span className="user-balance">
                {formatCurrency(user.balance, { compact: true })}
              </span>
            </div>
          </div>
        )}
        <button className="sidebar-logout" onClick={handleLogout} title="Logout" aria-label="Logout">
          <LogOut size={17} />
        </button>
      </div>
    </aside>
  )
}
