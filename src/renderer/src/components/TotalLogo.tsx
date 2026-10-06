import logo from '../../../../resources/total-256.png'

/** Decorative brand mark; adjacent text supplies the accessible product name. */
export function TotalLogo({ size = 32, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  return <img src={logo} alt="" aria-hidden="true" width={size} height={size} className={`shrink-0 ${className}`} />
}
