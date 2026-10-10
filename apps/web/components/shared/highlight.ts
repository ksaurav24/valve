import { codeToHtml } from 'shiki';

/** Shiki at build time, both themes in one pass; CSS picks one per theme. */
export function highlight(code: string, lang = 'ts') {
  return codeToHtml(code, {
    lang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  });
}
