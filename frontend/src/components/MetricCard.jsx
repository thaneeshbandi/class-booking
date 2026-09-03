import { Icon } from './Icon.jsx';

/** One headline dashboard metric — an icon in a tinted tone circle, the
 * value, and its label. `tone` picks which of the shared badge tones the
 * icon circle uses, purely decorative (never repeats information the value
 * itself doesn't already carry). */
export function MetricCard({ icon, value, label, tone = 'tone-blue' }) {
  return (
    <div className="stat-card">
      <span className={`stat-icon ${tone}`}>
        <Icon name={icon} size={18} />
      </span>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}
