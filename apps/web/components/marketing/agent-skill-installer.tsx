'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Check, Copy } from 'lucide-react';
import { agentSkills, skillCommand } from '@/lib/agent-skills';

export function AgentSkillInstaller({
  compact = false,
}: {
  compact?: boolean;
}) {
  const id = useId();
  const [name, setName] = useState('valve-setup');
  const [mode, setMode] = useState<'install' | 'prompt'>('install');
  const [status, setStatus] = useState('');
  const skill = agentSkills.find((item) => item.name === name)!;
  const value = mode === 'install' ? skillCommand(skill) : skill.prompt;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(mode === 'install' ? 'Command copied.' : 'Prompt copied.');
    } catch {
      setStatus('Copy failed. Select and copy the text below.');
    }
  }

  return (
    <div className="min-w-0 rounded-lg border border-border bg-background p-5 sm:p-6">
      {!compact && (
        <div className="mb-5 space-y-2">
          <label htmlFor={`${id}-skill`} className="block text-sm font-medium">
            What are you working on?
          </label>
          <select
            id={`${id}-skill`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setStatus('');
            }}
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <optgroup label="Use valve in your app">
              {agentSkills
                .filter((item) => !item.internal)
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.title}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Contribute to valve">
              {agentSkills
                .filter((item) => item.internal)
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.title}
                  </option>
                ))}
            </optgroup>
          </select>
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex gap-1"
          role="group"
          aria-label="Agent setup method"
        >
          {(['install', 'prompt'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              onClick={() => {
                setMode(item);
                setStatus('');
              }}
              className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
            >
              {item === 'install' ? 'Install skill' : 'Use a prompt'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-hover"
        >
          {status.endsWith('copied.') ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <Copy aria-hidden="true" className="size-4" />
          )}
          {mode === 'install' ? 'Copy command' : 'Copy prompt'}
        </button>
      </div>
      <textarea
        aria-label={
          mode === 'install' ? 'Skill installation command' : 'Agent prompt'
        }
        readOnly
        value={value}
        rows={mode === 'install' ? (skill.internal ? 4 : 3) : 8}
        spellCheck={false}
        className="mt-4 block w-full resize-y rounded-md bg-card p-4 font-mono text-[13px] leading-relaxed"
      />
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        {mode === 'install'
          ? 'Run in your project with Node.js 22.20+. The installer lets you choose your coding agent. It installs instructions; your agent adds valvejs when needed.'
          : 'Paste into your coding agent. It reads the skill and relevant references, then works with your project.'}
      </p>
      <div className="mt-3 flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <span role="status" aria-live="polite">
          {status}
        </span>
        {compact ? (
          <Link
            href="/skills"
            className="underline decoration-ring underline-offset-4 hover:decoration-foreground"
          >
            Browse all skills
          </Link>
        ) : (
          <a
            href={`https://github.com/ksaurav24/valve/blob/master/${skill.path}/SKILL.md`}
            className="underline decoration-ring underline-offset-4 hover:decoration-foreground"
          >
            Read this skill
          </a>
        )}
      </div>
    </div>
  );
}
