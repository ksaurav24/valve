import type { Metadata } from 'next';
import Link from 'next/link';
import { AgentSkillInstaller } from '@/components/marketing/agent-skill-installer';
import { PageHeader } from '@/components/marketing/page-header';
import { agentSkills } from '@/lib/agent-skills';
import { pageMetadata } from '@/lib/metadata';
import { site } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Agent skills',
  description:
    'Set up valve with your coding agent. Install skills for setup, Bottleneck migration, quota design, reviews, and troubleshooting.',
  path: '/skills',
});

export default function SkillsPage() {
  return (
    <>
      <PageHeader eyebrow="agent skills" title="Give your agent the context.">
        <p>
          Valve skills teach your coding agent how to choose a quota, share it
          across workers, and connect the calls already in your app.
        </p>
        <p className="text-muted-foreground">
          Install a skill for repeated use, or copy a prompt for a single task.
          Each skill includes focused references to the API and its guarantees.
        </p>
      </PageHeader>
      <div className="page-gutter py-14 sm:py-20">
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <section aria-labelledby="skill-list-title">
            <h2
              id="skill-list-title"
              className="text-2xl font-medium tracking-tight"
            >
              For your application
            </h2>
            <ul className="mt-6 divide-y divide-border">
              {agentSkills
                .filter((skill) => !skill.internal)
                .map((skill) => (
                  <li key={skill.name} className="py-5">
                    <a
                      href={`${site.source}/${skill.path}/SKILL.md`}
                      className="font-medium underline decoration-ring underline-offset-4 hover:decoration-foreground"
                    >
                      {skill.title}
                    </a>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {skill.description}
                    </p>
                  </li>
                ))}
            </ul>
            <div className="mt-10">
              <h2 className="text-2xl font-medium tracking-tight">
                For contributors
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Working on Valve itself? The repository also includes
                contribution and performance-harness skills. Choose either in
                the installer. These are hidden from default discovery because
                they apply to this repository.
              </p>
              <ul className="mt-4 space-y-3">
                {agentSkills
                  .filter((skill) => skill.internal)
                  .map((skill) => (
                    <li key={skill.name}>
                      <a
                        href={`${site.source}/${skill.path}/SKILL.md`}
                        className="text-sm underline decoration-ring underline-offset-4 hover:decoration-foreground"
                      >
                        {skill.title}
                      </a>
                    </li>
                  ))}
              </ul>
              <Link
                href="/contributors#guide"
                className="mt-5 inline-block text-sm underline decoration-ring underline-offset-4"
              >
                Contribution guide
              </Link>
            </div>
          </section>
          <section
            aria-label="Install or prompt your agent"
            className="order-first min-w-0 lg:order-none lg:sticky lg:top-24"
          >
            <AgentSkillInstaller />
            <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
              Works with Codex, Claude Code, Cursor, and other agents supported
              by the{' '}
              <a
                href="https://github.com/vercel-labs/skills"
                className="underline decoration-ring underline-offset-4"
              >
                Skills CLI
              </a>
              . You can also copy a skill folder, including its references, into
              your agent&apos;s project skills directory.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
