/**
 * Logo of a cloud service in the current text colour (path data in brands.ts).
 */
import { PATHS, type BrandService } from './brands';

/** The logo of a cloud service in the current text colour. */
export function BrandLogo({
  service,
  size = 17,
  className,
}: {
  service: BrandService;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path d={PATHS[service]} />
    </svg>
  );
}
