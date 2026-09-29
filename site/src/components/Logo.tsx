/** The eye of a peacock feather: Mayura means peacock in Sanskrit. */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <ellipse cx="16" cy="15.5" rx="11.5" ry="14" fill="#0a756f" />
      <ellipse cx="16" cy="17" rx="8.4" ry="10.4" fill="#d9a520" />
      <ellipse cx="16" cy="18" rx="6.3" ry="7.8" fill="#23b5b0" />
      <ellipse cx="16" cy="19.2" rx="3.6" ry="4.6" fill="#1b3a8f" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight text-fg">
      <LogoMark />
      <span className="text-[1.05rem]">Mayura</span>
    </span>
  );
}
