/**
 * A small, hand-rolled SVG icon set — not a dependency, not emoji. Every
 * icon is a 20x20 viewBox, stroke-based (matches a single visual language
 * across the whole set), and inherits `currentColor` so it always matches
 * whatever text color surrounds it without a separate color prop.
 */
const ICONS = {
  dashboard: 'M3 13h6V3H3v10Zm0 4h6v-2H3v2Zm8 0h6V9h-6v8Zm0-14v2h6V3h-6Z',
  members: 'M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1 17c0-3 2.7-5 6-5s6 2 6 5v0H1v0Zm11.5-4c2.2.2 4.5 1.4 4.5 4v0h-3.2',
  alerts: 'M10 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 4 5.66V13l1.4 2.1a1 1 0 0 1-.83 1.55H4.43a1 1 0 0 1-.83-1.55L5 13V9.27a6 6 0 0 1 4-5.67V3a1 1 0 0 1 1-1Zm-1.7 14.7a1.7 1.7 0 0 0 3.4 0',
  classes: 'M4 4h9l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm8 0v3h3M7 10h6M7 13h6',
  sessions: 'M6 2v3M14 2v3M3.5 7.5h13M4 4h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2.5 6.5h2v2h-2v-2Z',
  bookings: 'M5 3h10a1 1 0 0 1 1 1v13l-3-2-2 2-2-2-2 2-2-2V4a1 1 0 0 1 1-1Zm2 4h6M7 10h6',
  home: 'M3 9.5 10 3l7 6.5M5 8v8a1 1 0 0 0 1 1h3v-5h2v5h3a1 1 0 0 0 1-1V8',
  plus: 'M10 4v12M4 10h12',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM17 17l-3.5-3.5',
  edit: 'M13.5 3.5a1.7 1.7 0 0 1 2.4 2.4L6 16 2.5 17 3.5 13.5 13.5 3.5Z',
  trash: 'M4 5.5h12M8 5V3.6a.6.6 0 0 1 .6-.6h2.8a.6.6 0 0 1 .6.6V5M6 5.5 6.6 16a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L14 5.5',
  archive: 'M3 4h14v3H3V4Zm1 3h12v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Zm4 3.5h4',
  restore: 'M4 9a6 6 0 1 1 1.8 4.3M4 9V5M4 9h4',
  calendar: 'M5 3v3M15 3v3M3.5 7.5h13M4 4h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
  clock: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-10.5V10l3 2',
  users: 'M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1 17c0-3 2.7-5 6-5s6 2 6 5v0H1v0Zm11.5-4c2.2.2 4.5 1.4 4.5 4v0h-3.2',
  download: 'M10 3v10m0 0-3.5-3.5M10 13l3.5-3.5M4 16h12',
  logout: 'M8 17H4.6A1.6 1.6 0 0 1 3 15.4V4.6A1.6 1.6 0 0 1 4.6 3H8M13 14l4-4-4-4M17 10H7',
  chevronDown: 'M5 7.5 10 12.5 15 7.5',
  chevronRight: 'M7.5 5 12.5 10 7.5 15',
  close: 'M5 5l10 10M15 5 5 15',
  check: 'M4 10.5 8 14.5 16 5.5',
  warning: 'M10 2 18 16H2L10 2Zm0 5.5v4M10 14v.01',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-9.5V14M10 6v.01',
  menu: 'M3 6h14M3 10h14M3 14h14',
  inbox: 'M4 4h12l2 6v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6l2-6Zm-1.8 6H7l1 2h4l1-2h4.8',
};

export function Icon({ name, size = 18, strokeWidth = 1.7, className, ...rest }) {
  const path = ICONS[name];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <path d={path} />
    </svg>
  );
}
