import type { Contributor } from '@/lib/github';
import { cn } from '@/lib/utils';

export function ContributorGrid({
  contributors,
}: {
  contributors: Contributor[];
}) {
  return (
    <ul className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {contributors.map((person) => (
        <li key={person.login}>
          <a
            href={person.url}
            className="group flex min-h-20 items-center gap-4 rounded-md p-3 hover:bg-muted"
          >
            <img
              src={`${person.avatar}&s=96`}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              className="size-10 rounded-md grayscale-[35%] transition-[filter] duration-150 group-hover:grayscale-0"
            />
            <span className="min-w-0">
              <span className="block truncate text-base font-medium text-foreground">
                {person.login}
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {person.contributions}{' '}
                {person.contributions === 1 ? 'contribution' : 'contributions'}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function AvatarStack({
  contributors,
  className,
}: {
  contributors: Contributor[];
  className?: string;
}) {
  return (
    <div className={cn('flex -space-x-2', className)}>
      {contributors.slice(0, 12).map((person) => (
        <a
          key={person.login}
          href={person.url}
          title={person.login}
          className="relative rounded-full ring-2 ring-background transition-transform duration-150 hover:z-10 hover:-translate-y-0.5"
        >
          <img
            src={`${person.avatar}&s=64`}
            alt={person.login}
            width={32}
            height={32}
            loading="lazy"
            className="size-8 rounded-full"
          />
        </a>
      ))}
    </div>
  );
}
