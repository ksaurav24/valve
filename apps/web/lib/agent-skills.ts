// Shared skill catalogue and commands for the website.
import catalogue from '../../../skills/catalog.json';

export const agentSkills = catalogue;
export type AgentSkill = (typeof agentSkills)[number];

export function skillCommand(skill: AgentSkill) {
  const prefix = skill.internal ? 'INSTALL_INTERNAL_SKILLS=1 ' : '';
  return `${prefix}npx skills add ksaurav24/valve --skill ${skill.name}`;
}
