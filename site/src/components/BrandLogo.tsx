import { logos } from '../lib/logos';
import { asset } from '../lib/site';

/** A brand's logo in a square tile, with its dark-mode variant; a tile with its initials when there is no logo file. */
export function BrandLogo({ logo, size = 'md' }: { logo: string; size?: 'sm' | 'md' | 'lg' }) {
  const source = logos[logo] ?? { initials: logo.slice(0, 2).toUpperCase() };
  const box = { sm: 'size-7 rounded-md p-1', md: 'size-10 rounded-lg p-1.5', lg: 'size-14 rounded-xl p-2.5' }[size];
  if ('initials' in source) {
    const text = { sm: 'text-[0.55rem]', md: 'text-[0.7rem]', lg: 'text-sm' }[size];
    return (
      <span aria-hidden="true" className={`grid shrink-0 place-items-center border border-line bg-soft font-mono font-semibold tracking-tight text-muted ${box} ${text}`}>
        {source.initials}
      </span>
    );
  }
  const image = (file: string, className: string) => (
    <img src={asset(`logos/${file}.svg`)} alt="" loading="lazy" decoding="async" className={`size-full object-contain ${className}`} />
  );
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center border border-line bg-raised ${box}`}>
      {source.dark ? <>{image(source.light, 'dark:hidden')}{image(source.dark, 'hidden dark:block')}</> : image(source.light, '')}
    </span>
  );
}
