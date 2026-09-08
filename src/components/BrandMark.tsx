interface BrandMarkProps {
  size?: number;
  className?: string;
}

export default function BrandMark({ size = 32, className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 32 32"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#0b6b61" height="30" rx="8" width="30" x="1" y="1" />
      <path d="m9.5 9.5 5.6 6.5-5.6 6.5" fill="none" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
      <path d="M18 22.5h5" fill="none" stroke="#f28562" strokeLinecap="round" strokeWidth="2.6" />
      <circle cx="23" cy="9" fill="#f5c76b" r="1.6" />
    </svg>
  );
}
