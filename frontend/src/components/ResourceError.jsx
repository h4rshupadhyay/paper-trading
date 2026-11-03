export default function ResourceError({ message, onRetry, retryLabel = 'Retry' }) {
  if (!message) return null
  return (
    <div className="error-banner" role="alert">
      {message}{' '}
      {onRetry && <button className="btn btn-sm btn-outline" onClick={onRetry}>{retryLabel}</button>}
    </div>
  )
}
