import defaultComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import { Published, Unpublished } from '@/components/shared/release-gate';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultComponents,
    Step,
    Steps,
    Tab,
    Tabs,
    Published,
    Unpublished,
    ...components,
  };
}
export const useMDXComponents = getMDXComponents;
