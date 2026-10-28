interface CloudIconProps {
  provider: string;
  size?: number;
  className?: string;
}

/**
 * Simplified geometric marks for each cloud provider.
 * For production, replace the SVG bodies with the official assets from
 *   AWS: https://aws.amazon.com/architecture/icons/
 *   GCP: https://cloud.google.com/icons
 *   Azure: https://learn.microsoft.com/en-us/azure/architecture/icons/
 */
export function CloudIcon({ provider, size = 16, className = '' }: CloudIconProps) {
  const p = (provider || '').toLowerCase();
  const style = { width: size, height: size, display: 'inline-block', verticalAlign: 'middle' };
  const common = { width: size, height: size, viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' };

  if (p === 'aws') {
    return (
      <svg {...common} className={className} style={style} aria-label="AWS">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#FF9900" />
        <text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="700" fill="#ffffff" fontFamily="system-ui, sans-serif">aws</text>
      </svg>
    );
  }
  if (p === 'gcp') {
    return (
      <svg {...common} className={className} style={style} aria-label="GCP">
        <circle cx="12" cy="12" r="10" fill="#4285F4" />
        <path d="M12 6 L16 14 L8 14 Z" fill="#ffffff" />
        <circle cx="12" cy="12" r="2" fill="#34A853" />
      </svg>
    );
  }
  if (p === 'azure') {
    return (
      <svg {...common} className={className} style={style} aria-label="Azure">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#0078D4" />
        <path d="M7 17 L11 7 L14 7 L17 17 L14 17 L12.5 12.5 L11 17 Z" fill="#ffffff" />
      </svg>
    );
  }
  if (p === 'oracle') {
    return (
      <svg {...common} className={className} style={style} aria-label="Oracle Cloud">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#C74634" />
        <text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="700" fill="#ffffff" fontFamily="system-ui, sans-serif">OCI</text>
      </svg>
    );
  }
  if (p === 'ibm') {
    return (
      <svg {...common} className={className} style={style} aria-label="IBM Cloud">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#0F62FE" />
        <text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="700" fill="#ffffff" fontFamily="system-ui, sans-serif">IBM</text>
      </svg>
    );
  }
  if (p === 'alibaba') {
    return (
      <svg {...common} className={className} style={style} aria-label="Alibaba Cloud">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#FF6A00" />
        <text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="700" fill="#ffffff" fontFamily="system-ui, sans-serif">阿里</text>
      </svg>
    );
  }
  if (p === 'databricks') {
    return (
      <svg {...common} className={className} style={style} aria-label="Databricks">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#FF3621" />
        <path d="M6 12 L12 8 L18 12 L12 16 Z" fill="#ffffff" />
      </svg>
    );
  }
  return (
    <svg {...common} className={className} style={style} aria-label={provider}>
      <circle cx="12" cy="12" r="10" fill="#94a3b8" />
      <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#ffffff" fontFamily="system-ui, sans-serif">?</text>
    </svg>
  );
}